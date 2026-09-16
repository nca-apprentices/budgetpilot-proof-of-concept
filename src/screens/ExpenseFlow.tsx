/**
 * "Ausgabe erfassen": Freitext ODER Beleg-Foto → KI-Extraktion → Entwurf zum
 * Bestätigen, bevor irgendwas gespeichert wird.
 *
 * EntryScreen und DraftScreen werden bewusst hier zusammen mit ExpenseFlow
 * gehalten statt weiter aufgeteilt — beide werden nur von ExpenseFlow
 * gerendert und sind eng über lokale Closures/State gekoppelt (z.B.
 * handleWeiter/processBelegUri/handleBestaetigen), eine weitere Trennung
 * würde nur Props-Drilling ohne echten Vorteil erzeugen.
 *
 * @format
 */

import { useEffect, useMemo, useState } from 'react';
import {
  Alert,
  Image,
  Pressable,
  ScrollView,
  Text,
  TextInput,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { UseModelResult } from 'react-native-litert-lm';
import { launchCamera, launchImageLibrary } from 'react-native-image-picker';
import RNFS from 'react-native-fs';
import {
  ALLOWED_CATEGORIES,
  type Category,
  type Cadence,
  type LineItem,
  type Source,
} from '../budget';
import { recognizeReceiptText } from '../receiptOcr';
import {
  LOW_CONFIDENCE_THRESHOLD,
  buildDraftFromRaw,
  buildExtractionPrompt,
  buildReceiptOcrExtractionPrompt,
  extractJsonObject,
  findTotalAmountInOcrText,
  parseAmount,
  type Draft,
} from '../prompts';
import { createId } from '../idUtils';
import {
  BELEG_TEMP_PREFIX,
  cleanupTempBelegFiles,
  deleteBelegFile,
  stableBelegFilename,
} from '../belegFiles';
import { findDateInText, formatDateDMY, parseDateDMY, todayIso } from '../dateUtils';
import { useThemeColors } from '../theme';
import { getStyles } from '../styles';
import { AppButton } from '../components/AppButton';
import { DownloadProgressBar } from '../components/DownloadProgressBar';

export function ExpenseFlow({
  model,
  items,
  onConfirmItem,
  onUpdateItem,
  onDeleteItem,
  triggerUndo,
  prefilledDate,
  onPrefilledDateConsumed,
  itemToEdit,
  onItemEditConsumed,
}: {
  model: UseModelResult;
  items: LineItem[];
  onConfirmItem: (item: LineItem) => void;
  onUpdateItem: (id: string, patch: Partial<LineItem>) => void;
  onDeleteItem: (item: LineItem) => void;
  triggerUndo: (
    message: string,
    handlers: { onUndo: () => void; onExpire: () => void },
  ) => void;
  prefilledDate: string | null;
  onPrefilledDateConsumed: () => void;
  itemToEdit: LineItem | null;
  onItemEditConsumed: () => void;
}) {
  const {
    isReady,
    isGenerating,
    downloadProgress,
    error: modelError,
    generate,
    reset,
  } = model;
  // Nur relevant, wenn man aus dem Kalender kommt (Datum vorausgewählt) —
  // zeigt im Entry-Screen, was für diesen Tag schon erfasst wurde, statt
  // blind einen weiteren Posten hinzuzufügen, ohne die bestehenden zu sehen.
  const existingItemsForDate = useMemo(
    () => (prefilledDate ? items.filter(item => item.date === prefilledDate) : []),
    [items, prefilledDate],
  );
  const [step, setStep] = useState<'entry' | 'draft'>('entry');
  const [text, setText] = useState('');
  const [draft, setDraft] = useState<Draft | null>(null);
  const [draftInitialDate, setDraftInitialDate] = useState(todayIso());
  const [draftSource, setDraftSource] = useState<Source>('free_text');
  const [draftPhotoUri, setDraftPhotoUri] = useState<string | null>(null);
  // Pfad (nicht file://-URI) einer frisch gescannten, noch nicht bestätigten
  // Beleg-Kopie unter dem "beleg-scan-…"-Namen — null, solange draftPhotoUri
  // (falls gesetzt) nur das bereits gespeicherte Foto eines bearbeiteten
  // Postens zeigt. Entscheidet in handleVerwerfen, ob überhaupt eine
  // Temp-Datei zu löschen ist (das dauerhafte Foto eines Postens darf beim
  // blossen Verwerfen nie gelöscht werden, siehe dort), und in
  // handleBestaetigen, ob ein neues Foto zum stabilen Dateinamen befördert
  // werden muss.
  const [pendingPhotoTempPath, setPendingPhotoTempPath] = useState<string | null>(null);
  const [isProcessingPhoto, setIsProcessingPhoto] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Der komplette Original-Posten, solange der Entwurf-Screen ihn bearbeitet
  // statt einen neuen zu erfassen — liefert id/photoFilename/
  // manuallyEditedFields als Ausgangspunkt für handleBestaetigen. null bei
  // einer neuen Erfassung.
  const [editingItem, setEditingItem] = useState<LineItem | null>(null);
  // Erzwingt einen Remount von DraftScreen (siehe key={draftVersion} unten),
  // damit dessen lokaler State (TextInput-Werte) neu aus draft/initialDate
  // initialisiert wird — auch wenn man auf demselben Screen bleibt, z.B.
  // nach "Neue Quittung" während einer Bearbeitung.
  const [draftVersion, setDraftVersion] = useState(0);
  // Modell-Ladefehler (z.B. MemoryError) sind sonst unsichtbar — der Screen
  // bliebe endlos bei "Modell wird geladen…" hängen, ohne dass der Nutzer
  // erfährt, dass das Laden bereits fehlgeschlagen ist.
  const displayError = modelError ? `Fehler beim Laden des Modells: ${modelError}` : error;

  const handleWeiter = async () => {
    setError(null);
    try {
      // Jede Extraktion ist eine unabhängige Einzelanfrage — ohne Reset würde
      // sie an die wachsende Konversationshistorie älterer Aufrufe anhängen
      // und das Modell zunehmend verwirren (siehe CLAUDE.md Lessons Learned).
      reset();
      const result = await generate(buildExtractionPrompt(text));
      console.log('[extraction] Antwort:', result);
      const raw = extractJsonObject(result);
      setDraft(buildDraftFromRaw(raw));
      setDraftInitialDate(findDateInText(text) ?? prefilledDate ?? todayIso());
      onPrefilledDateConsumed();
      setDraftSource('free_text');
      setDraftPhotoUri(null);
      setDraftVersion(v => v + 1);
      setStep('draft');
    } catch (e) {
      console.error('[extraction] Fehler:', e);
      setError(
        'Die Antwort des Modells konnte nicht ausgewertet werden. Bitte erneut versuchen.',
      );
    }
  };

  const processBelegUri = async (uri: string) => {
    if (!model.model) {
      setError('Modell ist noch nicht bereit.');
      return;
    }
    setIsProcessingPhoto(true);
    try {
      // Sofort in einen dauerhaften Ort im eigenen App-Speicher kopieren,
      // statt die vom Bild-Picker gelieferte URI direkt weiterzuverwenden:
      // react-native-image-picker räumt seine temporäre Cache-Datei auf
      // Android schnell wieder auf (auf iOS bisher nie beobachtet) — bis die
      // langsame OCR+LLM-Verarbeitung fertig ist und der Entwurf-Screen das
      // Foto anzeigen will, existiert die ursprüngliche Datei sonst nicht
      // mehr (bestätigt: leeres Vorschau-Feld auf Android, siehe CLAUDE.md
      // Lessons Learned). Bewusst DocumentDirectoryPath statt
      // CachesDirectoryPath: Gemma 4s eigene XNNPACK-Kompilierungs-Caches
      // liegen im selben Cache-Ordner und sind teils >700 MB gross, wodurch
      // Android die App-Cache-Quota sprengt sieht und regelmässig (per
      // installd, ca. alle 60s beobachtet) automatisch älteste Dateien
      // purgt — inklusive unserer gerade erst kopierten Beleg-Datei, bevor
      // der Entwurf-Screen sie anzeigen konnte (bestätigt per Logcat).
      // Alte Scan-Zwischenstände zuerst löschen (siehe cleanupTempBelegFiles)
      // — sonst sammeln sich in DocumentDirectoryPath unbegrenzt Dateien an,
      // da dieser Ordner (bewusst, anders als CachesDirectoryPath) nicht vom
      // OS automatisch bereinigt wird. Betrifft nur den "beleg-scan-…"-Namensraum,
      // nicht die dauerhaften Beleg-Fotos bereits bestätigter Posten.
      await cleanupTempBelegFiles();
      const tempPath = `${RNFS.DocumentDirectoryPath}/${BELEG_TEMP_PREFIX}${Date.now()}.jpg`;
      await RNFS.copyFile(uri.replace('file://', ''), tempPath);
      const tempUri = `file://${tempPath}`;

      const ocrText = await recognizeReceiptText(tempUri);
      console.log('[extraction-photo] OCR-Text:', ocrText);
      // Wie beim Freitext-Pfad: jede Extraktion ist eine unabhängige
      // Einzelanfrage, sonst hängt sie an der Konversationshistorie
      // vorheriger Aufrufe (siehe CLAUDE.md Lessons Learned).
      reset();
      const result = await generate(buildReceiptOcrExtractionPrompt(ocrText));
      console.log('[extraction-photo] Antwort:', result);
      const raw = extractJsonObject(result);
      const photoDraft = buildDraftFromRaw(raw);
      // Betrag/Währung deterministisch überschreiben, falls die "TOTAL"-Zeile
      // im OCR-Text eindeutig gefunden wurde — zuverlässiger als das Modell
      // selbst zwischen mehreren echten Zahlen wählen zu lassen (siehe
      // findTotalAmountInOcrText und CLAUDE.md Lessons Learned).
      const totalHint = findTotalAmountInOcrText(ocrText);
      if (totalHint !== null) {
        photoDraft.amount = totalHint;
        photoDraft.currency = 'CHF';
      }
      setDraft(photoDraft);
      // Beim erneuten Scannen während einer Bearbeitung (siehe "Neue
      // Quittung" in DraftScreen) bleibt das Kaufdatum des bearbeiteten
      // Postens erhalten, statt es auf heute/prefilledDate zurückzusetzen —
      // hier geht es nur darum, die falsche Quittung zu ersetzen, nicht um
      // ein neues Datum.
      if (editingItem) {
        // Neue Quittung = neue Baseline: eine vorher persistierte
        // "(manuell geändert)"-Markierung bezog sich auf die ALTE
        // KI-Extraktion und gilt gegenüber dieser neuen nicht mehr (siehe
        // persistedManuallyEditedFields in DraftScreen).
        setEditingItem({ ...editingItem, manuallyEditedFields: [] });
      } else {
        setDraftInitialDate(prefilledDate ?? todayIso());
        onPrefilledDateConsumed();
      }
      setDraftSource('photo');
      setDraftPhotoUri(tempUri);
      setPendingPhotoTempPath(tempPath);
      setDraftVersion(v => v + 1);
      setStep('draft');
    } catch (e) {
      console.error('[extraction-photo] Fehler:', e);
      setError('Der Beleg konnte nicht ausgewertet werden. Bitte erneut versuchen.');
    } finally {
      setIsProcessingPhoto(false);
    }
  };

  const handleAufnehmen = async () => {
    setError(null);
    const photo = await launchCamera({ mediaType: 'photo', cameraType: 'back', quality: 1.0 });
    if (photo.didCancel) {
      return;
    }
    const uri = photo.assets?.[0]?.uri;
    if (photo.errorCode || !uri) {
      setError('Kamera konnte nicht geöffnet werden.');
      return;
    }
    await processBelegUri(uri);
  };

  const handleHochladen = async () => {
    setError(null);
    const photo = await launchImageLibrary({ mediaType: 'photo', quality: 1.0 });
    if (photo.didCancel) {
      return;
    }
    const uri = photo.assets?.[0]?.uri;
    if (photo.errorCode || !uri) {
      setError('Bild konnte nicht ausgewählt werden.');
      return;
    }
    await processBelegUri(uri);
  };

  const handleFoto = () => {
    Alert.alert('Beleg hinzufügen', undefined, [
      { text: 'Jetzt aufnehmen', onPress: handleAufnehmen },
      { text: 'Hochladen', onPress: handleHochladen },
      { text: 'Abbrechen', style: 'cancel' },
    ]);
  };

  const handleVerwerfen = () => {
    // Nur eine frisch gescannte, noch nicht bestätigte Temp-Datei löschen —
    // das dauerhafte Beleg-Foto eines bearbeiteten Postens (falls
    // draftPhotoUri darauf zeigt) bleibt beim blossen Verwerfen unangetastet.
    if (pendingPhotoTempPath) {
      deleteBelegFile(pendingPhotoTempPath);
    }
    setDraft(null);
    setDraftPhotoUri(null);
    setPendingPhotoTempPath(null);
    setEditingItem(null);
    setStep('entry');
  };

  // Löscht den gerade bearbeiteten Posten unwiderruflich — nur im
  // Bearbeiten-Modus erreichbar (siehe DraftScreen), daher kein Check auf
  // editingItem !== null hier nötig, der Button existiert sonst nicht.
  const handleLoeschen = () => {
    if (!editingItem) {
      return;
    }
    Alert.alert(
      'Posten löschen',
      `"${editingItem.description}" wirklich unwiderruflich löschen?`,
      [
        { text: 'Abbrechen', style: 'cancel' },
        {
          text: 'Löschen',
          style: 'destructive',
          onPress: () => {
            // Ein evtl. frisch gescannter, noch nicht bestätigter
            // Zwischenstand gehört nicht zum gelöschten Posten und wird
            // separat aufgeräumt, statt verwaist liegen zu bleiben.
            if (pendingPhotoTempPath) {
              deleteBelegFile(pendingPhotoTempPath);
            }
            onDeleteItem(editingItem);
            setDraft(null);
            setDraftPhotoUri(null);
            setPendingPhotoTempPath(null);
            setEditingItem(null);
            setStep('entry');
          },
        },
      ],
    );
  };

  const handleBestaetigen = async (
    finalDraft: Draft,
    date: string,
    changedFieldsThisSession: string[],
  ) => {
    const id = editingItem?.id ?? createId();
    // Union statt Ersetzen: ein Feld, das in einer früheren Session schon
    // manuell geändert wurde, bleibt markiert, auch wenn es diesmal nicht
    // angefasst wurde.
    const manuallyEditedFields = Array.from(
      new Set([...(editingItem?.manuallyEditedFields ?? []), ...changedFieldsThisSession]),
    );

    // Frisch gescanntes Foto zum dauerhaften, postenspezifischen Dateinamen
    // befördern — ersetzt dabei ein evtl. vorhandenes altes Foto desselben
    // Postens (identischer Dateiname, siehe stableBelegFilename), da "Neue
    // Quittung" die alte Quittung ersetzen soll, nicht danebenlegen. Ein
    // vorhandenes altes Foto wird dabei bewusst nicht sofort gelöscht,
    // sondern nur beiseitegelegt (Endung ".undo") — erst wenn das
    // Undo-Fenster unten abläuft, wird es endgültig entfernt. So kann
    // "Rückgängig" das alte Foto wiederherstellen.
    let photoFilename = editingItem?.photoFilename ?? null;
    let restoreOldPhoto: (() => Promise<void>) | null = null;
    let discardOldPhotoBackup: (() => Promise<void>) | null = null;
    if (pendingPhotoTempPath) {
      const stableName = stableBelegFilename(id);
      const stablePath = `${RNFS.DocumentDirectoryPath}/${stableName}`;
      const backupPath = `${stablePath}.undo`;
      const hadOldPhoto = editingItem?.photoFilename != null;
      try {
        if (hadOldPhoto) {
          await deleteBelegFile(backupPath); // Rest eines abgelaufenen, älteren Undo-Fensters
          await RNFS.moveFile(stablePath, backupPath);
        } else {
          await deleteBelegFile(stablePath);
        }
        await RNFS.moveFile(pendingPhotoTempPath, stablePath);
        photoFilename = stableName;
        if (hadOldPhoto) {
          restoreOldPhoto = async () => {
            await deleteBelegFile(stablePath);
            await RNFS.moveFile(backupPath, stablePath);
          };
          discardOldPhotoBackup = async () => {
            await deleteBelegFile(backupPath);
          };
        } else {
          // Vorher gab es kein Foto — bei "Rückgängig" das gerade erst
          // abgelegte neue Foto wieder entfernen, statt es verwaist liegen
          // zu lassen (die DB zeigt nach dem Undo wieder photoFilename=null).
          restoreOldPhoto = async () => {
            await deleteBelegFile(stablePath);
          };
        }
      } catch (e) {
        console.error('[expense] Beleg-Foto konnte nicht übernommen werden:', e);
      }
    }

    if (editingItem) {
      const previousItem = editingItem;
      onUpdateItem(editingItem.id, {
        description: finalDraft.description,
        amount: finalDraft.amount,
        currency: finalDraft.currency,
        cadence: finalDraft.cadence,
        category: finalDraft.category,
        date,
        photoFilename,
        manuallyEditedFields,
      });
      // Undo nur anbieten, wenn wirklich neu gescannt wurde — eine reine
      // Text-/Betrags-Korrektur ohne "Neue Quittung" bekommt kein Banner.
      if (pendingPhotoTempPath) {
        triggerUndo('Neue Quittung übernommen', {
          onUndo: () => {
            onUpdateItem(previousItem.id, {
              description: previousItem.description,
              amount: previousItem.amount,
              currency: previousItem.currency,
              cadence: previousItem.cadence,
              category: previousItem.category,
              date: previousItem.date,
              photoFilename: previousItem.photoFilename,
              manuallyEditedFields: previousItem.manuallyEditedFields,
            });
            restoreOldPhoto?.();
          },
          onExpire: () => {
            discardOldPhotoBackup?.();
          },
        });
      }
    } else {
      const item: LineItem = {
        id,
        description: finalDraft.description,
        amount: finalDraft.amount,
        currency: finalDraft.currency,
        cadence: finalDraft.cadence,
        category: finalDraft.category,
        source: draftSource,
        confidence: finalDraft.confidence,
        notes: finalDraft.reason,
        date,
        photoFilename,
        manuallyEditedFields,
      };
      console.log('[expense] Bestätigt:', item);
      onConfirmItem(item);
    }
    setDraft(null);
    setDraftPhotoUri(null);
    setPendingPhotoTempPath(null);
    setEditingItem(null);
    setText('');
    setStep('entry');
  };

  // Öffnet einen bereits bestätigten Posten wieder im Entwurf-Screen — z.B.
  // wenn beim Foto-Erfassen die falsche Quittung ausgewählt wurde. Zeigt das
  // dauerhaft gespeicherte Beleg-Foto des Postens (falls vorhanden) direkt an
  // — ersetzt wird es erst, wenn im Entwurf-Screen "Neue Quittung" ausgeführt
  // wird (siehe processBelegUri/handleBestaetigen).
  const beginEditItem = (item: LineItem) => {
    setDraft({
      description: item.description,
      amount: item.amount,
      currency: item.currency,
      cadence: item.cadence,
      category: item.category,
      confidence: item.confidence,
      reason: item.notes,
    });
    setDraftInitialDate(item.date);
    setDraftSource(item.source);
    setDraftPhotoUri(
      item.photoFilename
        ? `file://${RNFS.DocumentDirectoryPath}/${item.photoFilename}`
        : null,
    );
    setPendingPhotoTempPath(null);
    setEditingItem(item);
    setDraftVersion(v => v + 1);
    setStep('draft');
  };

  // Kommt vom Budget-Tab (siehe itemToEdit/onItemEditConsumed in App()) —
  // der Kalender-Tag-Detail-Fall ruft beginEditItem direkt auf, da man dort
  // schon auf diesem Screen ist.
  useEffect(() => {
    if (itemToEdit) {
      beginEditItem(itemToEdit);
      onItemEditConsumed();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [itemToEdit]);

  if (step === 'draft' && draft) {
    return (
      <DraftScreen
        key={draftVersion}
        draft={draft}
        initialDate={draftInitialDate}
        photoUri={draftPhotoUri}
        isEditing={editingItem !== null}
        persistedManuallyEditedFields={editingItem?.manuallyEditedFields ?? []}
        isProcessingPhoto={isProcessingPhoto}
        onRescan={handleFoto}
        onConfirm={handleBestaetigen}
        onDiscard={handleVerwerfen}
        onDelete={handleLoeschen}
      />
    );
  }

  return (
    <EntryScreen
      text={text}
      onChangeText={setText}
      onWeiter={handleWeiter}
      onFoto={handleFoto}
      isReady={isReady}
      isBusy={isGenerating || isProcessingPhoto}
      downloadProgress={downloadProgress}
      error={displayError}
      prefilledDate={prefilledDate}
      existingItemsForDate={existingItemsForDate}
      onEditItem={beginEditItem}
    />
  );
}

function EntryScreen({
  text,
  onChangeText,
  onWeiter,
  onFoto,
  isReady,
  isBusy,
  downloadProgress,
  error,
  prefilledDate,
  existingItemsForDate,
  onEditItem,
}: {
  text: string;
  onChangeText: (t: string) => void;
  onWeiter: () => void;
  onFoto: () => void;
  isReady: boolean;
  isBusy: boolean;
  downloadProgress: number;
  error: string | null;
  prefilledDate: string | null;
  existingItemsForDate: LineItem[];
  onEditItem: (item: LineItem) => void;
}) {
  const insets = useSafeAreaInsets();
  const colors = useThemeColors();
  const styles = useMemo(() => getStyles(colors), [colors]);

  let status = 'Modell wird geladen…';
  if (isReady) {
    status = 'Modell bereit.';
  } else if (downloadProgress > 0) {
    status = 'Lade Modell (~2.6 GB)…';
  }

  return (
    <ScrollView
      style={styles.container}
      contentContainerStyle={{
        paddingTop: 20,
        paddingBottom: insets.bottom + 24,
        paddingHorizontal: 20,
      }}
    >
      <Text style={styles.title}>Ausgabe erfassen</Text>
      <Text style={styles.status}>{status}</Text>
      {prefilledDate && (
        <Text style={styles.status}>
          Für {formatDateDMY(prefilledDate)} — aus dem Kalender ausgewählt.
        </Text>
      )}
      {!isReady && downloadProgress > 0 && (
        <DownloadProgressBar progress={downloadProgress} />
      )}

      <Text style={styles.label}>Ausgabe als Freitext:</Text>
      <TextInput
        style={styles.input}
        value={text}
        onChangeText={onChangeText}
        multiline
        placeholder="z.B. Miete 1200 CHF monatlich"
        placeholderTextColor={colors.placeholder}
      />

      {error && <Text style={styles.errorText}>{error}</Text>}

      {existingItemsForDate.length > 0 && (
        <>
          <Text style={[styles.label, { textTransform: 'none', letterSpacing: 0 }]}>
            Bereits erfasst für {formatDateDMY(prefilledDate as string)} (antippen zum
            Bearbeiten):
          </Text>
          {existingItemsForDate.map(item => (
            <Pressable
              key={item.id}
              style={styles.lineItemRow}
              onPress={() => onEditItem(item)}
            >
              <Text style={styles.lineItemDescription}>{item.description}</Text>
              <Text style={styles.lineItemMeta}>
                {item.amount !== null
                  ? `${item.amount.toFixed(2)} ${item.currency}`
                  : '—'}{' '}
                · {item.category ?? 'Sonstiges'} ·{' '}
                {item.cadence === 'monthly' ? 'Fixkosten' : 'Einmalig'}
              </Text>
            </Pressable>
          ))}
        </>
      )}

      <View style={styles.buttonRow}>
        <View style={styles.buttonWrapper}>
          <AppButton
            title={isBusy ? 'Analysiere…' : 'Weiter'}
            onPress={onWeiter}
            disabled={!isReady || isBusy || text.trim().length === 0}
          />
        </View>
        <View style={styles.buttonWrapper}>
          <AppButton
            title={isBusy ? 'Analysiere…' : '📷 Beleg fotografieren'}
            onPress={onFoto}
            disabled={!isReady || isBusy}
            variant="secondary"
          />
        </View>
      </View>
    </ScrollView>
  );
}

function DraftScreen({
  draft,
  initialDate,
  photoUri,
  isEditing,
  persistedManuallyEditedFields,
  isProcessingPhoto,
  onRescan,
  onConfirm,
  onDiscard,
  onDelete,
}: {
  draft: Draft;
  initialDate: string;
  photoUri: string | null;
  isEditing: boolean;
  persistedManuallyEditedFields: string[];
  isProcessingPhoto: boolean;
  onRescan: () => void;
  onConfirm: (d: Draft, date: string, changedFields: string[]) => void;
  onDiscard: () => void;
  onDelete: () => void;
}) {
  const insets = useSafeAreaInsets();
  const colors = useThemeColors();
  const styles = useMemo(() => getStyles(colors), [colors]);
  const [description, setDescription] = useState(draft.description);
  const [amountText, setAmountText] = useState(
    draft.amount === null ? '' : String(draft.amount),
  );
  const [currency, setCurrency] = useState(draft.currency);
  const [cadence, setCadence] = useState<Cadence>(draft.cadence);
  const [category, setCategory] = useState<Category | null>(draft.category);
  const [dateText, setDateText] = useState(formatDateDMY(initialDate));

  const lowConfidence =
    draft.confidence !== null && draft.confidence < LOW_CONFIDENCE_THRESHOLD;

  const parsedAmount = parseAmount(amountText);
  // An der aktuellen Eingabe statt am ursprünglichen KI-Wert festmachen, damit
  // der Hinweis verschwindet, sobald der Nutzer das Feld ausgefüllt hat.
  const amountNeedsInput = parsedAmount === null;
  const categoryNeedsInput = category === null;

  const canConfirm =
    description.trim().length > 0 && parsedAmount !== null && category !== null;

  const fieldStyle = (needsInput: boolean) => [
    styles.input,
    lowConfidence && styles.lowConfidenceBorder,
    needsInput && styles.needsInputBorder,
  ];

  // Vergleich gegen die KI-Extraktion (draft/initialDate) dieser Session —
  // zeigt sofort "(manuell geändert)", sobald der User ein Feld anfasst,
  // statt erst nach dem Bestätigen. Vereinigt mit den aus einer früheren
  // Session schon persistierten Feldern (persistedManuallyEditedFields), da
  // ein nicht erneut angefasstes Feld seine Markierung behalten soll.
  const changedFieldsThisSession = useMemo(() => {
    const changed: string[] = [];
    if (description.trim() !== draft.description) {
      changed.push('description');
    }
    if (parsedAmount !== draft.amount) {
      changed.push('amount');
    }
    if ((currency.trim() || 'CHF') !== draft.currency) {
      changed.push('currency');
    }
    if (cadence !== draft.cadence) {
      changed.push('cadence');
    }
    if (category !== draft.category) {
      changed.push('category');
    }
    if (dateText !== formatDateDMY(initialDate)) {
      changed.push('date');
    }
    return changed;
  }, [description, parsedAmount, currency, cadence, category, dateText, draft, initialDate]);

  const effectiveManuallyEditedFields = useMemo(
    () =>
      Array.from(new Set([...persistedManuallyEditedFields, ...changedFieldsThisSession])),
    [persistedManuallyEditedFields, changedFieldsThisSession],
  );

  const fieldLabel = (text: string, field: string) => (
    <Text style={styles.label}>
      {text}
      {effectiveManuallyEditedFields.includes(field) && (
        <Text style={styles.manualEditBadge}> (manuell geändert)</Text>
      )}
    </Text>
  );

  return (
    <ScrollView
      style={styles.container}
      contentContainerStyle={{
        paddingTop: 20,
        paddingBottom: insets.bottom + 24,
        paddingHorizontal: 20,
      }}
    >
      <Text style={styles.title}>
        {isEditing ? 'Entwurf bearbeiten' : 'Entwurf bestätigen'}
      </Text>
      {draft.confidence !== null && (
        <Text style={styles.status}>
          Vertrauen der KI-Extraktion: {Math.round(draft.confidence * 100)}%
        </Text>
      )}

      {photoUri && (
        <Image
          source={{ uri: photoUri }}
          style={styles.receiptPreview}
          resizeMode="contain"
        />
      )}

      {isEditing && (
        <View style={styles.buttonRow}>
          <View style={styles.buttonWrapper}>
            <AppButton
              title={isProcessingPhoto ? 'Analysiere…' : '📷 Neue Quittung'}
              onPress={onRescan}
              disabled={isProcessingPhoto}
              variant="secondary"
            />
          </View>
        </View>
      )}

      {fieldLabel('Beschreibung', 'description')}
      <TextInput
        style={fieldStyle(false)}
        value={description}
        onChangeText={setDescription}
        placeholder="Beschreibung"
        placeholderTextColor={colors.placeholder}
      />

      {fieldLabel('Betrag', 'amount')}
      <TextInput
        style={fieldStyle(amountNeedsInput)}
        value={amountText}
        onChangeText={setAmountText}
        keyboardType="numeric"
        placeholder={amountNeedsInput ? 'Betrag eingeben' : undefined}
        placeholderTextColor={colors.placeholder}
      />
      {amountNeedsInput && (
        <Text style={styles.needsInputHint}>Bitte Betrag ausfüllen.</Text>
      )}

      {fieldLabel('Währung', 'currency')}
      <TextInput
        style={styles.input}
        value={currency}
        onChangeText={setCurrency}
        placeholder="CHF"
        placeholderTextColor={colors.placeholder}
      />

      {fieldLabel('Häufigkeit', 'cadence')}
      <View
        style={[styles.segmentRow, lowConfidence && styles.lowConfidenceBorder]}
      >
        <Pressable
          style={[
            styles.segmentButton,
            cadence === 'monthly' && styles.segmentButtonActive,
          ]}
          onPress={() => setCadence('monthly')}
        >
          <Text
            style={[
              styles.segmentText,
              cadence === 'monthly' && styles.segmentTextActive,
            ]}
          >
            monatlich
          </Text>
        </Pressable>
        <Pressable
          style={[
            styles.segmentButton,
            cadence === 'one_time' && styles.segmentButtonActive,
          ]}
          onPress={() => setCadence('one_time')}
        >
          <Text
            style={[
              styles.segmentText,
              cadence === 'one_time' && styles.segmentTextActive,
            ]}
          >
            einmalig
          </Text>
        </Pressable>
      </View>

      {fieldLabel('Kategorie', 'category')}
      <View
        style={[
          styles.chipContainer,
          lowConfidence && styles.lowConfidenceBorder,
          categoryNeedsInput && styles.needsInputBorder,
        ]}
      >
        {ALLOWED_CATEGORIES.map(c => (
          <Pressable
            key={c}
            style={[styles.chip, category === c && styles.chipSelected]}
            onPress={() => setCategory(c)}
          >
            <Text
              style={[
                styles.chipText,
                category === c && styles.chipTextSelected,
              ]}
            >
              {c}
            </Text>
          </Pressable>
        ))}
      </View>
      {categoryNeedsInput && (
        <Text style={styles.needsInputHint}>Bitte Kategorie auswählen.</Text>
      )}

      {fieldLabel('Kaufdatum', 'date')}
      <TextInput
        style={styles.input}
        value={dateText}
        onChangeText={setDateText}
        placeholder="TT.MM.JJJJ"
        keyboardType="numeric"
        placeholderTextColor={colors.placeholder}
      />

      <View style={styles.buttonRow}>
        <View style={styles.buttonWrapper}>
          <AppButton
            title="Bestätigen"
            disabled={!canConfirm}
            onPress={() =>
              onConfirm(
                {
                  description: description.trim(),
                  amount: parsedAmount,
                  currency: currency.trim() || 'CHF',
                  cadence,
                  category,
                  confidence: draft.confidence,
                  reason: draft.reason,
                },
                parseDateDMY(dateText) ?? todayIso(),
                changedFieldsThisSession,
              )
            }
          />
        </View>
        <View style={styles.buttonWrapper}>
          <AppButton title="Verwerfen" onPress={onDiscard} variant="secondary" />
        </View>
        {isEditing && (
          <View style={styles.buttonWrapper}>
            <AppButton title="Löschen" onPress={onDelete} variant="danger" />
          </View>
        )}
      </View>
    </ScrollView>
  );
}
