package com.budgetpilot

import android.graphics.Rect
import android.net.Uri
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.google.mlkit.vision.common.InputImage
import com.google.mlkit.vision.text.TextRecognition
import com.google.mlkit.vision.text.latin.TextRecognizerOptions

/**
 * Android-Gegenstück zu ios/budgetpilot/ReceiptOCR.swift: liest Beleg-Text
 * per Google ML Kit Text Recognition (on-device, kein Internet nötig) aus,
 * statt das multimodale LLM (Gemma 4 E2B-it) das Foto selbst lesen zu
 * lassen (siehe CLAUDE.md Risiken/Lessons Learned zur unzuverlässigen
 * direkten Bild-Extraktion).
 *
 * ML Kit gruppiert erkannten Text bereits selbst in Blocks/Lines, aber bei
 * mehrspaltigen Belegen (Label links, Betrag rechts) kann die Block-
 * Reihenfolge trotzdem nicht der visuellen Zeile entsprechen — genau das
 * Problem, das auf iOS beobachtet wurde (siehe CLAUDE.md Lessons Learned
 * #19). Deshalb hier dieselbe Lösung: alle erkannten Zeilen anhand ihrer
 * Bounding-Box neu zu Zeilen gruppieren (nach Y-Position) und links nach
 * rechts sortieren, statt Blocks/Lines unverändert zu übernehmen.
 */
class ReceiptOCRModule(reactContext: ReactApplicationContext) :
  ReactContextBaseJavaModule(reactContext) {

  override fun getName(): String = "ReceiptOCR"

  @ReactMethod
  fun recognizeText(uri: String, promise: Promise) {
    try {
      val image = InputImage.fromFilePath(reactApplicationContext, Uri.parse(uri))
      val recognizer = TextRecognition.getClient(TextRecognizerOptions.DEFAULT_OPTIONS)
      recognizer
        .process(image)
        .addOnSuccessListener { result ->
          val lines = result.textBlocks.flatMap { it.lines }
          promise.resolve(reconstructRows(lines, image.height))
        }
        .addOnFailureListener { error ->
          promise.reject("ocr_failed", error.message, error)
        }
    } catch (error: Exception) {
      promise.reject("invalid_image", "Bild konnte nicht geladen werden: $uri", error)
    }
  }

  private data class LineBox(val text: String, val box: Rect)

  private fun reconstructRows(
    mlKitLines: List<com.google.mlkit.vision.text.Text.Line>,
    imageHeightPx: Int,
  ): String {
    val items =
      mlKitLines.mapNotNull { line ->
        val box = line.boundingBox ?: return@mapNotNull null
        LineBox(line.text, box)
      }
    // Android-Koordinaten: Ursprung oben links, y wächst nach unten —
    // aufsteigend nach y sortieren ergibt oben-nach-unten Lesereihenfolge.
    val sorted = items.sortedBy { it.box.centerY() }

    val rows = mutableListOf<MutableList<LineBox>>()
    // Relativ zur Bildhöhe statt fixer Pixelwert (analog zu ReceiptOCR.swift,
    // dort 0.015 der normalisierten Bildhöhe) — sonst skaliert der
    // Schwellenwert nicht mit unterschiedlichen Foto-Auflösungen.
    val rowThresholdPx = (imageHeightPx * 0.015).toInt().coerceAtLeast(10)
    for (item in sorted) {
      val lastRow = rows.lastOrNull()
      val firstY = lastRow?.firstOrNull()?.box?.centerY()
      if (lastRow != null && firstY != null && Math.abs(firstY - item.box.centerY()) < rowThresholdPx) {
        lastRow.add(item)
      } else {
        rows.add(mutableListOf(item))
      }
    }

    return rows.joinToString("\n") { row ->
      row.sortedBy { it.box.left }.joinToString(" ") { it.text }
    }
  }
}
