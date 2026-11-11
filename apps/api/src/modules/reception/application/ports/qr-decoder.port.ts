export interface QrDecoder {
  /**
   * Looks for a SIFEN QR code in an image and returns the 44-digit CDC found in its URL (`Id`
   * parameter), or `null` when there is no QR, the image is unreadable or the QR carries no CDC.
   * Never throws for bad input: the QR is only a hint ahead of the LLM.
   */
  decodeCdc(image: Uint8Array): Promise<string | null>;
}
