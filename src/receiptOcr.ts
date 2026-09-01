import { NativeModules } from 'react-native';

// Native Bridge zu Apples Vision-Framework (VNRecognizeTextRequest), siehe
// ios/budgetpilot/ReceiptOCR.swift. Nur iOS — ein Android-Äquivalent
// (z.B. ML Kit Text Recognition) ist noch nicht implementiert.
type ReceiptOCRModule = {
  recognizeText(uri: string): Promise<string>;
};

const { ReceiptOCR } = NativeModules as { ReceiptOCR: ReceiptOCRModule };

export function recognizeReceiptText(uri: string): Promise<string> {
  return ReceiptOCR.recognizeText(uri);
}
