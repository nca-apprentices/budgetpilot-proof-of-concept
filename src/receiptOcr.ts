import { NativeModules } from 'react-native';

// Native Bridge zur Text-Erkennung: auf iOS Apples Vision-Framework
// (ios/budgetpilot/ReceiptOCR.swift), auf Android Google ML Kit Text
// Recognition (android/.../ReceiptOCRModule.kt) — beide unter demselben
// Modulnamen "ReceiptOCR" registriert, damit dieser Wrapper plattform-
// unabhängig bleibt.
type ReceiptOCRModule = {
  recognizeText(uri: string): Promise<string>;
};

const { ReceiptOCR } = NativeModules as { ReceiptOCR: ReceiptOCRModule };

export function recognizeReceiptText(uri: string): Promise<string> {
  return ReceiptOCR.recognizeText(uri);
}
