import { parsePhoneNumberFromString, type CountryCode } from 'libphonenumber-js';

export function normalizePhone(raw: string, defaultCountry: CountryCode = 'KH'): { normalized?: string; e164?: string } {
  const input = raw.trim();
  try {
    const pn = parsePhoneNumberFromString(input, defaultCountry);
    if (!pn) return {};
    if (!pn.isValid()) return {};
    return { normalized: pn.formatInternational(), e164: pn.number }; // e164 includes +country and digits
  } catch {
    return {};
  }
}


