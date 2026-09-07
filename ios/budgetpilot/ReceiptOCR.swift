import Foundation
import UIKit
import Vision

// On-device OCR für Beleg-Fotos: liest den Rohtext per Apples Vision-
// Framework aus, statt ihn dem multimodalen LLM (Gemma 4 E2B-it) direkt als
// Bild zu geben. Grund: kleine Multimodal-Modelle sind bei feinem
// Beleg-Druck unzuverlässig (siehe CLAUDE.md Risiken/Lessons Learned),
// Vision-OCR ist dafür ausgelegt und läuft ebenfalls komplett on-device.
// Der erkannte Text wird danach über den bereits bewährten Freitext-
// Extraktionspfad (buildExtractionPrompt) an das LLM übergeben.
@objc(ReceiptOCR)
class ReceiptOCR: NSObject {

  @objc
  static func requiresMainQueueSetup() -> Bool {
    return false
  }

  @objc(recognizeText:resolver:rejecter:)
  func recognizeText(
    _ uri: String,
    resolver: @escaping (Any?) -> Void,
    rejecter: @escaping (String?, String?, Error?) -> Void
  ) {
    guard let url = URL(string: uri),
          let data = try? Data(contentsOf: url),
          let image = UIImage(data: data),
          let cgImage = image.cgImage
    else {
      rejecter("invalid_image", "Bild konnte nicht geladen werden: \(uri)", nil)
      return
    }

    let request = VNRecognizeTextRequest { request, error in
      if let error = error {
        rejecter("ocr_failed", error.localizedDescription, error)
        return
      }
      let observations = request.results as? [VNRecognizedTextObservation] ?? []
      resolver(Self.reconstructRows(from: observations))
    }
    request.recognitionLevel = .accurate
    request.usesLanguageCorrection = true

    let handler = VNImageRequestHandler(cgImage: cgImage, options: [:])
    DispatchQueue.global(qos: .userInitiated).async {
      do {
        try handler.perform([request])
      } catch {
        rejecter("ocr_failed", error.localizedDescription, error)
      }
    }
  }

  // Vision liefert Text-Observations in einer Reihenfolge, die bei Belegen
  // mit zwei Spalten (Label links, Betrag rechts) NICHT der visuellen
  // Zeile entspricht — beobachtet wurde, dass alle linksbündigen Labels
  // ("TOTAL CHF", "BAR", "Zurück CHF") zuerst kommen und die rechtsbündigen
  // Beträge erst danach als eigene Gruppe, ohne Bezug zu ihrem Label (siehe
  // CLAUDE.md Lessons Learned). Diese Funktion nutzt stattdessen die
  // Bounding-Box jeder Observation, um Text mit ähnlicher vertikaler
  // Position als eine Zeile zu gruppieren (von oben nach unten sortiert)
  // und innerhalb einer Zeile von links nach rechts zu ordnen — rekonstruiert
  // damit z.B. "TOTAL CHF 9.95" wieder als zusammenhängende Zeile.
  private static func reconstructRows(from observations: [VNRecognizedTextObservation]) -> String {
    struct Item { let text: String; let box: CGRect }
    let items = observations.compactMap { obs -> Item? in
      guard let candidate = obs.topCandidates(1).first else { return nil }
      return Item(text: candidate.string, box: obs.boundingBox)
    }
    // Vision-Koordinaten: Ursprung unten links, y wächst nach oben —
    // absteigend nach y sortieren ergibt oben-nach-unten Lesereihenfolge.
    let sorted = items.sorted { $0.box.midY > $1.box.midY }

    var rows: [[Item]] = []
    let rowThreshold: CGFloat = 0.015
    for item in sorted {
      if let lastFirstY = rows.last?.first?.box.midY, abs(lastFirstY - item.box.midY) < rowThreshold {
        rows[rows.count - 1].append(item)
      } else {
        rows.append([item])
      }
    }

    return rows
      .map { row in row.sorted { $0.box.minX < $1.box.minX }.map { $0.text }.joined(separator: " ") }
      .joined(separator: "\n")
  }
}
