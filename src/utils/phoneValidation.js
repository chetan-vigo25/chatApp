// National (subscriber) number length per dialing code — excludes the country code.
// { min, max } are inclusive digit counts of the number the user types after the +code.
const PHONE_RULES = {
  '+91': { min: 10, max: 10 },  // India
  '+1': { min: 10, max: 10 },   // US / Canada
  '+44': { min: 10, max: 10 },  // United Kingdom
  '+86': { min: 11, max: 11 },  // China
  '+81': { min: 10, max: 10 },  // Japan
  '+82': { min: 9, max: 10 },   // South Korea
  '+65': { min: 8, max: 8 },    // Singapore
  '+971': { min: 9, max: 9 },   // UAE
  '+966': { min: 9, max: 9 },   // Saudi Arabia
  '+61': { min: 9, max: 9 },    // Australia
  '+49': { min: 10, max: 11 },  // Germany
  '+33': { min: 9, max: 9 },    // France
  '+39': { min: 9, max: 10 },   // Italy
  '+34': { min: 9, max: 9 },    // Spain
  '+7': { min: 10, max: 10 },   // Russia
  '+55': { min: 10, max: 11 },  // Brazil
  '+52': { min: 10, max: 10 },  // Mexico
  '+27': { min: 9, max: 9 },    // South Africa
  '+234': { min: 10, max: 10 }, // Nigeria
  '+20': { min: 10, max: 10 },  // Egypt
  '+880': { min: 10, max: 10 }, // Bangladesh
  '+92': { min: 10, max: 10 },  // Pakistan
  '+94': { min: 9, max: 9 },    // Sri Lanka
  '+977': { min: 10, max: 10 }, // Nepal
  '+93': { min: 9, max: 9 },    // Afghanistan
  '+98': { min: 10, max: 10 },  // Iran
  '+90': { min: 10, max: 10 },  // Turkey
  '+974': { min: 8, max: 8 },   // Qatar
  '+965': { min: 8, max: 8 },   // Kuwait
  '+973': { min: 8, max: 8 },   // Bahrain
  '+968': { min: 8, max: 8 },   // Oman
  '+60': { min: 9, max: 10 },   // Malaysia
  '+66': { min: 9, max: 9 },    // Thailand
  '+84': { min: 9, max: 10 },   // Vietnam
  '+63': { min: 10, max: 10 },  // Philippines
  '+62': { min: 9, max: 12 },   // Indonesia
  '+855': { min: 8, max: 9 },   // Cambodia
  '+856': { min: 8, max: 10 },  // Laos
  '+95': { min: 8, max: 10 },   // Myanmar
  '+975': { min: 8, max: 8 },   // Bhutan
  '+960': { min: 7, max: 7 },   // Maldives
};

// E.164 allows at most 15 digits including the country code.
const DEFAULT_RULE = { min: 6, max: 14 };

export function getPhoneRule(dialCode) {
  return PHONE_RULES[dialCode] || DEFAULT_RULE;
}

export function isPhoneValid(dialCode, nationalNumber) {
  const { min, max } = getPhoneRule(dialCode);
  const len = (nationalNumber || '').length;
  return len >= min && len <= max;
}

// Human-readable expected length, e.g. "10 digits" or "9–12 digits".
export function phoneLengthHint(dialCode) {
  const { min, max } = getPhoneRule(dialCode);
  return min === max ? `${min} digits` : `${min}–${max} digits`;
}
