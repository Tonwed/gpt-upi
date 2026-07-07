const MAX_QR_DECODED_TEXT_LENGTH = 2048;

export function readQrMetadata(form: FormData) {
  const decodedValue = form.get("qrDecodedText");
  const decodedText =
    typeof decodedValue === "string"
      ? decodedValue.trim().slice(0, MAX_QR_DECODED_TEXT_LENGTH) || null
      : null;

  const isUpiValue = form.get("qrIsUpi");
  const qrIsUpi = isUpiValue === null ? null : String(isUpiValue) === "true";

  return {
    qrDecodedText: decodedText,
    qrIsUpi,
  };
}
