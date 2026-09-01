import {
  PDFDocument,
  rgb,
  StandardFonts,
  type PDFFont,
  type PDFPage,
  type Color,
} from 'pdf-lib';
import RNFS from 'react-native-fs';
import { Share } from 'react-native';
import { CATEGORY_COLORS, type LineItem } from './budget';
import type { BudgetSummary } from './budgetEngine';

const PAGE_WIDTH = 595.28; // A4 in pt
const PAGE_HEIGHT = 841.89;
const MARGIN = 40;
const CONTENT_WIDTH = PAGE_WIDTH - MARGIN * 2;

const COLORS = {
  pageBg: '#faf8f4',
  cardBg: '#ffffff',
  cardBorder: '#e8e3da',
  labelGray: '#6b7d63',
  textPrimary: '#2b2b28',
  textMuted: '#8a8578',
  accent: '#d1653b',
  progressTrack: '#dfe6d6',
  warningBg: '#fbe6d8',
  warningText: '#7a3c1c',
  aiPillBg: '#4f9d8f',
};

function hexToColor(hex: string): Color {
  const n = parseInt(hex.replace('#', ''), 16);
  return rgb(((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255);
}

function uint8ArrayToBase64(bytes: Uint8Array): string {
  const chars =
    'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  let result = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i];
    const b1 = i + 1 < bytes.length ? bytes[i + 1] : undefined;
    const b2 = i + 2 < bytes.length ? bytes[i + 2] : undefined;
    result += chars[b0 >> 2];
    result += chars[((b0 & 3) << 4) | (b1 === undefined ? 0 : b1 >> 4)];
    result +=
      b1 === undefined
        ? '='
        : chars[((b1 & 15) << 2) | (b2 === undefined ? 0 : b2 >> 6)];
    result += b2 === undefined ? '=' : chars[b2 & 63];
  }
  return result;
}

// SVG-Pfad für ein abgerundetes Rechteck, lokal verankert bei (0,0) = obere
// linke Ecke, y wächst nach unten (Standard-SVG-Konvention — pdf-lib dreht
// das beim Zeichnen automatisch in sein eigenes Koordinatensystem, siehe
// pdf-lib-Quellcode zu drawSvgPath: "SVG path Y axis is opposite pdf-lib's").
function roundedRectPath(w: number, h: number, radiusIn: number): string {
  const r = Math.max(0, Math.min(radiusIn, w / 2, h / 2));
  return `M ${r},0 L ${w - r},0 A ${r},${r} 0 0 1 ${w},${r} L ${w},${
    h - r
  } A ${r},${r} 0 0 1 ${w - r},${h} L ${r},${h} A ${r},${r} 0 0 1 0,${
    h - r
  } L 0,${r} A ${r},${r} 0 0 1 ${r},0 Z`;
}

function drawRoundedRect(
  page: PDFPage,
  opts: {
    x: number;
    y: number;
    width: number;
    height: number;
    radius: number;
    color: Color;
  },
) {
  // (x, y) ist hier die UNTERE linke Ecke, wie bei pdf-lib's eigenem
  // drawRectangle/drawText — passend zu allen Aufrufstellen in dieser Datei.
  // roundedRectPath() selbst ist lokal oben-links verankert (SVG-Konvention),
  // daher hier auf die obere Kante umrechnen (y + height), bevor an
  // drawSvgPath übergeben wird (das intern automatisch auf pdf-libs
  // Koordinatensystem zurückdreht, siehe Kommentar dort).
  page.drawSvgPath(roundedRectPath(opts.width, opts.height, opts.radius), {
    x: opts.x,
    y: opts.y + opts.height,
    color: opts.color,
  });
}

type Fonts = {
  heroItalic: PDFFont;
  regular: PDFFont;
  medium: PDFFont;
  bold: PDFFont;
};

// Custom-Font-Embedding (Fraunces/Karla via pdf-lib + @pdf-lib/fontkit) führte
// unter Hermes zu falsch dargestellten Glyphen, obwohl dieselben Font-Bytes
// in Node fehlerfrei liefen (siehe CLAUDE.md Lessons Learned) — deshalb
// bewusst Standard-Fonts statt Custom-Embedding, garantiert lesbar.
async function embedFonts(doc: PDFDocument): Promise<Fonts> {
  const [heroItalic, regular, medium, bold] = await Promise.all([
    doc.embedFont(StandardFonts.TimesRomanItalic),
    doc.embedFont(StandardFonts.Helvetica),
    doc.embedFont(StandardFonts.Helvetica),
    doc.embedFont(StandardFonts.HelveticaBold),
  ]);
  return { heroItalic, regular, medium, bold };
}

// Baut die Seite von oben nach unten auf und bricht bei Bedarf automatisch
// auf eine neue Seite um, sobald der Cursor den unteren Rand erreicht.
class ReportWriter {
  y: number;
  page: PDFPage;

  constructor(private doc: PDFDocument, private fonts: Fonts) {
    this.page = this.newPage();
    this.y = PAGE_HEIGHT - MARGIN;
  }

  private newPage(): PDFPage {
    const page = this.doc.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
    page.drawRectangle({
      x: 0,
      y: 0,
      width: PAGE_WIDTH,
      height: PAGE_HEIGHT,
      color: hexToColor(COLORS.pageBg),
    });
    return page;
  }

  ensureSpace(height: number) {
    if (this.y - height < MARGIN) {
      this.page = this.newPage();
      this.y = PAGE_HEIGHT - MARGIN;
    }
  }

  advance(amount: number) {
    this.y -= amount;
  }

  label(text: string, opts: { align?: 'left' | 'right' } = {}) {
    const size = 9;
    this.ensureSpace(size * 1.6);
    const font = this.fonts.medium;
    const x =
      opts.align === 'right'
        ? PAGE_WIDTH - MARGIN - font.widthOfTextAtSize(text, size)
        : MARGIN;
    this.page.drawText(text, {
      x,
      y: this.y - size,
      size,
      font,
      color: hexToColor(COLORS.labelGray),
    });
  }

  hero(text: string) {
    const size = 34;
    this.ensureSpace(size * 1.3);
    this.page.drawText(text, {
      x: MARGIN,
      y: this.y - size,
      size,
      font: this.fonts.heroItalic,
      color: hexToColor(COLORS.textPrimary),
    });
    this.advance(size * 1.3);
  }

  text(
    str: string,
    opts: {
      size?: number;
      font?: PDFFont;
      color?: string;
      align?: 'left' | 'right';
      x?: number;
      gapAfter?: number;
    } = {},
  ) {
    const size = opts.size ?? 11;
    const font = opts.font ?? this.fonts.regular;
    const lineHeight = size * 1.45;
    this.ensureSpace(lineHeight);
    const x =
      opts.x ??
      (opts.align === 'right'
        ? PAGE_WIDTH - MARGIN - font.widthOfTextAtSize(str, size)
        : MARGIN);
    this.page.drawText(str, {
      x,
      y: this.y - size,
      size,
      font,
      color: hexToColor(opts.color ?? COLORS.textPrimary),
    });
    this.advance(lineHeight + (opts.gapAfter ?? 0));
  }

  // Einfacher Wortumbruch anhand der tatsächlichen Zeichenbreite der Schrift.
  paragraph(
    str: string,
    opts: { size?: number; font?: PDFFont; color?: string } = {},
  ) {
    const size = opts.size ?? 11;
    const font = opts.font ?? this.fonts.regular;
    const words = str.split(/\s+/).filter(Boolean);
    let current = '';
    for (const word of words) {
      const candidate = current ? `${current} ${word}` : word;
      if (current && font.widthOfTextAtSize(candidate, size) > CONTENT_WIDTH) {
        this.text(current, { size, font, color: opts.color });
        current = word;
      } else {
        current = candidate;
      }
    }
    if (current) {
      this.text(current, { size, font, color: opts.color });
    }
  }

  divider() {
    this.ensureSpace(1);
    this.page.drawLine({
      start: { x: MARGIN, y: this.y },
      end: { x: PAGE_WIDTH - MARGIN, y: this.y },
      thickness: 1,
      color: hexToColor(COLORS.cardBorder),
    });
  }

  save(): Promise<Uint8Array> {
    return this.doc.save();
  }
}

const CARD_HEIGHT = 34;
const CARD_RADIUS = 6;
const CARD_GAP = 6;
const CHIP_HEIGHT = 16;
const CHIP_PADDING_X = 8;
const DATE_PILL_BG = '#eef0ea';

function itemCard(writer: ReportWriter, item: LineItem, fonts: Fonts) {
  writer.ensureSpace(CARD_HEIGHT + CARD_GAP);
  const top = writer.y;
  const cardY = top - CARD_HEIGHT;

  drawRoundedRect(writer.page, {
    x: MARGIN,
    y: cardY,
    width: CONTENT_WIDTH,
    height: CARD_HEIGHT,
    radius: CARD_RADIUS,
    color: hexToColor(COLORS.cardBg),
  });

  // Einzeilig: Kategorie-Chip + Datums-Pille nebeneinander links, dann
  // Beschreibung, Betrag rechtsbündig — alles vertikal auf Kartenmitte.
  const rowCenterY = cardY + CARD_HEIGHT / 2;
  const chipY = rowCenterY - CHIP_HEIGHT / 2;

  const chipLabel = item.category ?? 'Sonstiges';
  const chipColor = CATEGORY_COLORS[item.category ?? 'Sonstiges'];
  const chipFontSize = 8;
  const chipTextWidth = fonts.bold.widthOfTextAtSize(chipLabel, chipFontSize);
  const chipWidth = chipTextWidth + CHIP_PADDING_X * 2;
  const chipX = MARGIN + 10;

  drawRoundedRect(writer.page, {
    x: chipX,
    y: chipY,
    width: chipWidth,
    height: CHIP_HEIGHT,
    radius: CHIP_HEIGHT / 2,
    color: hexToColor(chipColor),
  });

  writer.page.drawText(chipLabel, {
    x: chipX + CHIP_PADDING_X,
    y: chipY + (CHIP_HEIGHT - chipFontSize) / 2 + 1,
    size: chipFontSize,
    font: fonts.bold,
    color: rgb(1, 1, 1),
  });

  const dateLabel = formatDateDMY(item.date);
  const dateFontSize = 8;
  const dateTextWidth = fonts.bold.widthOfTextAtSize(dateLabel, dateFontSize);
  const datePillWidth = dateTextWidth + CHIP_PADDING_X * 2;
  const datePillX = chipX + chipWidth + 6;

  drawRoundedRect(writer.page, {
    x: datePillX,
    y: chipY,
    width: datePillWidth,
    height: CHIP_HEIGHT,
    radius: CHIP_HEIGHT / 2,
    color: hexToColor(DATE_PILL_BG),
  });

  writer.page.drawText(dateLabel, {
    x: datePillX + CHIP_PADDING_X,
    y: chipY + (CHIP_HEIGHT - dateFontSize) / 2 + 1,
    size: dateFontSize,
    font: fonts.bold,
    color: hexToColor(COLORS.labelGray),
  });

  const descriptionSize = 11;
  const descriptionX = datePillX + datePillWidth + 12;
  writer.page.drawText(item.description, {
    x: descriptionX,
    y: rowCenterY - descriptionSize / 2 + 1,
    size: descriptionSize,
    font: fonts.regular,
    color: hexToColor(COLORS.textPrimary),
  });

  const amountText =
    item.amount !== null ? `${item.amount.toFixed(2)} ${item.currency}` : '—';
  const amountSize = 12;
  const amountWidth = fonts.bold.widthOfTextAtSize(amountText, amountSize);
  writer.page.drawText(amountText, {
    x: MARGIN + CONTENT_WIDTH - 14 - amountWidth,
    y: cardY + (CARD_HEIGHT - amountSize) / 2 + 1,
    size: amountSize,
    font: fonts.bold,
    color: hexToColor(COLORS.textPrimary),
  });

  writer.y = cardY - CARD_GAP;
}

export type PdfBudgetReportInput = {
  income: number | null;
  items: LineItem[];
  summary: BudgetSummary;
  aiSummaryText: string | null;
};

export async function buildBudgetReportPdf({
  income,
  items,
  summary,
  aiSummaryText,
}: PdfBudgetReportInput): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const fonts = await embedFonts(doc);
  const writer = new ReportWriter(doc, fonts);

  const exactDate = new Date().toLocaleDateString('de-CH', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  });

  // 1. Kopfzeile
  writer.label('BUDGETÜBERSICHT');
  writer.label(exactDate, { align: 'right' });
  writer.advance(16);
  writer.divider();
  writer.advance(20);

  // 2. Einkommen prominent (Hero-Zeile)
  writer.label('EINKOMMEN');
  writer.advance(4);
  writer.hero(
    income !== null ? `CHF ${formatAmount(income)}` : 'nicht erfasst',
  );
  writer.advance(20);

  // 3. Fixkosten / geplante Käufe
  const fixedCosts = items.filter(item => item.cadence === 'monthly');
  const plannedPurchases = items.filter(item => item.cadence === 'one_time');

  writer.label('FIXKOSTEN (MONATLICH)');
  writer.advance(10);
  if (fixedCosts.length === 0) {
    writer.text('Keine erfasst.', { size: 10, color: COLORS.textMuted });
  } else {
    fixedCosts.forEach(item => itemCard(writer, item, fonts));
  }
  writer.text(`Zwischensumme: CHF ${formatAmount(summary.totalFixedCosts)}`, {
    size: 10,
    color: COLORS.textMuted,
  });
  writer.advance(16);

  writer.label('GEPLANTE KÄUFE (EINMALIG)');
  writer.advance(10);
  if (plannedPurchases.length === 0) {
    writer.text('Keine erfasst.', { size: 10, color: COLORS.textMuted });
  } else {
    plannedPurchases.forEach(item => itemCard(writer, item, fonts));
  }
  writer.text(
    `Zwischensumme: CHF ${formatAmount(summary.totalPlannedPurchases)}`,
    {
      size: 10,
      color: COLORS.textMuted,
    },
  );
  writer.advance(4);
  writer.text(`Gesamtsumme: CHF ${formatAmount(summary.totalSpent)}`, {
    size: 11,
    font: fonts.bold,
    color: COLORS.textPrimary,
  });
  writer.advance(20);

  // 4. Restbudget-Block
  const progressBarHeight = 8;
  const restboxPadding = 16;
  const restboxHeight =
    restboxPadding * 2 + 9 + 6 + 34 + 4 + 14 + 10 + progressBarHeight;
  writer.ensureSpace(restboxHeight);
  const restboxTop = writer.y;
  const restboxY = restboxTop - restboxHeight;
  drawRoundedRect(writer.page, {
    x: MARGIN,
    y: restboxY,
    width: CONTENT_WIDTH,
    height: restboxHeight,
    radius: 10,
    color: hexToColor(COLORS.cardBg),
  });
  writer.y = restboxTop - restboxPadding;
  const innerLeft = MARGIN + restboxPadding;
  const innerWidth = CONTENT_WIDTH - restboxPadding * 2;

  writer.page.drawText('RESTBUDGET', {
    x: innerLeft,
    y: writer.y - 9,
    size: 9,
    font: fonts.medium,
    color: hexToColor(COLORS.labelGray),
  });
  writer.advance(9 + 6);

  const restAmountText =
    summary.restbudget !== null
      ? `CHF ${formatAmount(summary.restbudget)}`
      : '—';
  writer.page.drawText(restAmountText, {
    x: innerLeft,
    y: writer.y - 30,
    size: 30,
    font: fonts.heroItalic,
    color: hexToColor(COLORS.textPrimary),
  });
  writer.advance(34);

  const percentText =
    income !== null && summary.restbudgetPercent !== null
      ? `${summary.restbudgetPercent.toFixed(1)}% von CHF ${formatAmount(
          income,
        )} Einkommen`
      : 'Einkommen noch nicht erfasst';
  writer.page.drawText(percentText, {
    x: innerLeft,
    y: writer.y - 10,
    size: 10,
    font: fonts.regular,
    color: hexToColor(COLORS.textMuted),
  });
  writer.advance(14 + 10);

  const clampedPercent = Math.max(
    0,
    Math.min(100, summary.restbudgetPercent ?? 0),
  );
  drawRoundedRect(writer.page, {
    x: innerLeft,
    y: writer.y - progressBarHeight,
    width: innerWidth,
    height: progressBarHeight,
    radius: progressBarHeight / 2,
    color: hexToColor(COLORS.progressTrack),
  });
  const filledWidth = (innerWidth * clampedPercent) / 100;
  if (filledWidth > 1) {
    drawRoundedRect(writer.page, {
      x: innerLeft,
      y: writer.y - progressBarHeight,
      width: filledWidth,
      height: progressBarHeight,
      radius: progressBarHeight / 2,
      color: hexToColor(COLORS.accent),
    });
  }
  writer.y = restboxY - 20;

  // 5. Warnungs-Banner
  if (summary.warnings.length > 0) {
    for (const warning of summary.warnings) {
      const bannerPadding = 12;
      const bannerHeight = 34;
      writer.ensureSpace(bannerHeight + 12);
      const bannerTop = writer.y;
      const bannerY = bannerTop - bannerHeight;
      drawRoundedRect(writer.page, {
        x: MARGIN,
        y: bannerY,
        width: CONTENT_WIDTH,
        height: bannerHeight,
        radius: 8,
        color: hexToColor(COLORS.warningBg),
      });
      writer.page.drawText(warning, {
        x: MARGIN + bannerPadding,
        y: bannerY + (bannerHeight - 11) / 2 + 1,
        size: 11,
        font: fonts.medium,
        color: hexToColor(COLORS.warningText),
      });
      writer.y = bannerY - 12;
    }
  }

  // 6. KI-Zusammenfassungs-Box
  if (aiSummaryText) {
    const boxPadding = 16;
    const pillHeight = 16;
    const estimatedLines = Math.max(
      1,
      Math.ceil(
        fonts.regular.widthOfTextAtSize(aiSummaryText, 11) /
          (CONTENT_WIDTH - boxPadding * 2),
      ),
    );
    const boxHeight =
      boxPadding * 2 + pillHeight + 10 + estimatedLines * 11 * 1.45;
    writer.ensureSpace(boxHeight);
    const boxTop = writer.y;
    const boxY = boxTop - boxHeight;
    drawRoundedRect(writer.page, {
      x: MARGIN,
      y: boxY,
      width: CONTENT_WIDTH,
      height: boxHeight,
      radius: 10,
      color: hexToColor(COLORS.cardBg),
    });
    writer.y = boxTop - boxPadding;

    const pillLabel = 'KI · BITTE PRÜFEN';
    const pillFontSize = 8;
    const pillTextWidth = fonts.bold.widthOfTextAtSize(pillLabel, pillFontSize);
    const pillWidth = pillTextWidth + 16;
    drawRoundedRect(writer.page, {
      x: MARGIN + boxPadding,
      y: writer.y - pillHeight,
      width: pillWidth,
      height: pillHeight,
      radius: pillHeight / 2,
      color: hexToColor(COLORS.aiPillBg),
    });
    writer.page.drawText(pillLabel, {
      x: MARGIN + boxPadding + 8,
      y: writer.y - pillHeight + (pillHeight - pillFontSize) / 2 + 1,
      size: pillFontSize,
      font: fonts.bold,
      color: rgb(1, 1, 1),
    });
    writer.y -= pillHeight + 10;

    const contentLeft = MARGIN + boxPadding;
    const words = aiSummaryText.split(/\s+/).filter(Boolean);
    let current = '';
    const innerContentWidth = CONTENT_WIDTH - boxPadding * 2;
    for (const word of words) {
      const candidate = current ? `${current} ${word}` : word;
      if (
        current &&
        fonts.regular.widthOfTextAtSize(candidate, 11) > innerContentWidth
      ) {
        writer.page.drawText(current, {
          x: contentLeft,
          y: writer.y - 11,
          size: 11,
          font: fonts.regular,
          color: hexToColor(COLORS.textPrimary),
        });
        writer.advance(11 * 1.45);
        current = word;
      } else {
        current = candidate;
      }
    }
    if (current) {
      writer.page.drawText(current, {
        x: contentLeft,
        y: writer.y - 11,
        size: 11,
        font: fonts.regular,
        color: hexToColor(COLORS.textPrimary),
      });
      writer.advance(11 * 1.45);
    }
    writer.y = boxY - 20;
  }

  // 7. Footer
  writer.ensureSpace(20);
  writer.page.drawText('BudgetPilot POC · alle Daten bleiben auf dem Gerät', {
    x: MARGIN,
    y: MARGIN - 10,
    size: 8,
    font: fonts.regular,
    color: hexToColor(COLORS.textMuted),
  });

  return writer.save();
}

function formatAmount(n: number): string {
  return n.toLocaleString('de-CH', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

function formatDateDMY(iso: string | undefined): string {
  if (!iso) {
    return '—';
  }
  const [year, month, day] = iso.split('-');
  return year && month && day ? `${day}.${month}.${year}` : iso;
}

export async function savePdfAndShare(
  bytes: Uint8Array,
  fileName: string,
): Promise<string> {
  const base64 = uint8ArrayToBase64(bytes);
  const path = `${RNFS.DocumentDirectoryPath}/${fileName}`;
  await RNFS.writeFile(path, base64, 'base64');
  await Share.share({ url: `file://${path}` });
  return path;
}
