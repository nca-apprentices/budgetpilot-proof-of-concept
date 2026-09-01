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
      let lines = observations.compactMap { $0.topCandidates(1).first?.string }
      resolver(lines.joined(separator: "\n"))
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
}
