/**
 * Normalizes a string by converting Turkish characters to their English ASCII equivalents
 * and converting to lowercase.
 *
 * Example: "İstanbul" -> "istanbul", "Çanakkale" -> "canakkale"
 *
 * @param text The text to normalize
 * @returns The normalized string
 */
export const normalizeText = (text: string): string => {
    if (!text) return '';

    return text
        .replace(/İ/g, 'i')
        .replace(/I/g, 'i')
        .replace(/ı/g, 'i')
        .replace(/Ş/g, 's')
        .replace(/ş/g, 's')
        .replace(/Ğ/g, 'g')
        .replace(/ğ/g, 'g')
        .replace(/Ü/g, 'u')
        .replace(/ü/g, 'u')
        .replace(/Ö/g, 'o')
        .replace(/ö/g, 'o')
        .replace(/Ç/g, 'c')
        .replace(/ç/g, 'c')
        .toLowerCase()
        .trim();
};
