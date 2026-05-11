import CryptoJS from 'crypto-js';
import { SALT_SECRET, CONTACT_SALT } from '@env';

class ContactHasher {
  constructor() {
    this.algorithm = 'sha256';
    this.saltLength = 32;
    this.cipherVersion = 'v2';
  }

  generatePseudoRandomBytes(byteLength) {
    const words = [];
    for (let i = 0; i < byteLength; i += 4) {
      const randomWord = ((Math.random() * 0x100000000) | 0);
      words.push(randomWord);
    }
    return CryptoJS.lib.WordArray.create(words, byteLength);
  }

  getRandomWordArray(byteLength) {
    try {
      return CryptoJS.lib.WordArray.random(byteLength);
    } catch (error) {
      console.warn('Secure random unavailable, using fallback RNG:', error?.message || error);
      return this.generatePseudoRandomBytes(byteLength);
    }
  }
 
  generateSalt() {
    try {
      return this.getRandomWordArray(this.saltLength).toString();
    } catch (error) {
      console.error('Error generating salt:', error);
      return Array.from({length: this.saltLength}, () =>
        Math.floor(Math.random() * 256).toString(16).padStart(2, '0')
      ).join('');
    }
  }
 
  normalizePhoneNumber(phoneNumber) {
    try {
      if (!phoneNumber || typeof phoneNumber !== 'string') {
        throw new Error('Invalid phone number');
      }
      
      let normalized = phoneNumber.replace(/[^\d+]/g, '');
      
      if (normalized.length === 0) {
        return phoneNumber;
      }
      
      if (!normalized.startsWith('+')) {
        normalized = normalized.replace(/^0+/, '');
        normalized = '+91' + normalized;
      }
      
      if (normalized.length < 8) {
        console.warn('Phone number seems too short:', normalized);
      }
      
      return normalized;
    } catch (error) {
      console.error('Error normalizing phone number:', error);
      return phoneNumber;
    }
  }

  getEncryptionKey() {
    const secret = String(CONTACT_SALT || 'default_salt_123');
    return CryptoJS.SHA256(secret);
  }

  // Versioned AES-CBC encryption with IV prefix for stable cross-screen decrypt
  encryptContent(plainText) {
    if (!plainText) return "";
    try {
      const key = this.getEncryptionKey();
      const iv = this.getRandomWordArray(16);
      
      const encrypted = CryptoJS.AES.encrypt(plainText, key, {
        iv: iv,
        mode: CryptoJS.mode.CBC,
        padding: CryptoJS.pad.Pkcs7
      });

      const ivHex = CryptoJS.enc.Hex.stringify(iv);
      const cipherHex = CryptoJS.enc.Hex.stringify(encrypted.ciphertext);
      return `${this.cipherVersion}:${ivHex}:${cipherHex}`;
    } catch (err) {
      console.error('Error encrypting content:', err);
      return "";
    }
  }

  decryptLegacyCombinedBase64(cipherText) {
    const key = this.getEncryptionKey();

    const combined = CryptoJS.enc.Base64.parse(cipherText);
    const iv = CryptoJS.lib.WordArray.create(combined.words.slice(0, 4), 16);
    const cipherSigBytes = Math.max((combined.sigBytes || 0) - 16, 0);
    const ciphertext = CryptoJS.lib.WordArray.create(combined.words.slice(4), cipherSigBytes);

    const decrypted = CryptoJS.AES.decrypt(
      { ciphertext },
      key,
      { iv, mode: CryptoJS.mode.CBC, padding: CryptoJS.pad.Pkcs7 }
    );

    return decrypted.toString(CryptoJS.enc.Utf8);
  }

  decryptVersioned(cipherText) {
    const parts = String(cipherText).split(':');
    if (parts.length !== 3) return "";

    const [version, ivHex, cipherHex] = parts;
    if (version !== this.cipherVersion) return "";

    const key = this.getEncryptionKey();
    const iv = CryptoJS.enc.Hex.parse(ivHex);
    const ciphertext = CryptoJS.enc.Hex.parse(cipherHex);

    const decrypted = CryptoJS.AES.decrypt(
      { ciphertext },
      key,
      { iv, mode: CryptoJS.mode.CBC, padding: CryptoJS.pad.Pkcs7 }
    );

    return decrypted.toString(CryptoJS.enc.Utf8);
  }

  // Decrypts v2 format and supports old payloads for backward compatibility
  decryptContent(cipherText) {
    if (!cipherText) return "";
    try {
      const text = String(cipherText).trim();

      if (text.startsWith(`${this.cipherVersion}:`)) {
        return this.decryptVersioned(text);
      }

      const legacyCombined = this.decryptLegacyCombinedBase64(text);
      if (legacyCombined) return legacyCombined;

      const passphraseFallback = CryptoJS.AES.decrypt(text, String(CONTACT_SALT || 'default_salt_123'));
      return passphraseFallback.toString(CryptoJS.enc.Utf8);
    } catch (err) {
      console.error('Error decrypting content:', err);
      return "";
    }
  }

  decryptPhoneNumber(encryptNumber, salt = SALT_SECRET) {
    const decrypted = this.decryptContent(encryptNumber);
    if (!decrypted) return '';
    const suffix = String(salt || '');
    if (suffix && decrypted.endsWith(suffix)) {
      return decrypted.slice(0, decrypted.length - suffix.length);
    }
    return decrypted;
  }
 
  hashPhoneNumber(phoneNumber, salt = null) {
    try {
      const normalized = this.normalizePhoneNumber(phoneNumber);
      const usedSalt = salt || SALT_SECRET;
      const dataToHash = normalized + usedSalt;
      const hash = CryptoJS.SHA256(dataToHash).toString(CryptoJS.enc.Hex);
      const encryptNumber = this.encryptContent(dataToHash);
      
      return {
        hash: hash.toLowerCase(),
        salt: usedSalt,
        algorithm: this.algorithm,
        normalized,
        originalPhone: phoneNumber,
        encryptNumber: encryptNumber
      };
    } catch (error) {
      console.error('Error hashing phone number:', error);
      throw error;
    }
  }
 
  hashContactList(contacts) {
    const hashedContacts = [];
    
    for (const contact of contacts) {
      try {
        let phoneNumber = null;
        
        if (contact.phoneNumbers && contact.phoneNumbers.length > 0) {
          phoneNumber = contact.phoneNumbers[0].number;
        } else if (contact.phoneNumber) {
          phoneNumber = contact.phoneNumber;
        }
        
        if (!phoneNumber) {
          continue;
        }
        
        const hashed = this.hashPhoneNumber(phoneNumber);
        hashedContacts.push({
          id: contact.id || `${Date.now()}_${Math.random()}`,
          fullName: contact.name || '',
          hash: hashed.hash,
          salt: hashed.salt,
          algorithm: hashed.algorithm,
          normalizedPhone: hashed.normalized,
          encryptNumber: hashed.encryptNumber || null,
          originalPhone: phoneNumber
        });
      } catch (error) {
        console.warn(`Failed to hash contact ${contact.name || 'unknown'}:`, error);
      }
    }
    
    return hashedContacts;
  }
 
  validateHashedContact(hashedContact) {
    try {
      if (!hashedContact) return false;
      
      const { hash, salt, algorithm } = hashedContact;
      
      if (!hash || !salt || !algorithm) {
        console.error('Missing required fields in hashed contact');
        return false;
      }
      
      const hashRegex = /^[a-f0-9]{64}$/;
      if (!hashRegex.test(hash.toLowerCase())) {
        console.error('Invalid hash format:', hash);
        return false;
      }
      
      const saltRegex = /^[a-f0-9]+$/i;
      if (!saltRegex.test(salt)) {
        console.error('Invalid salt format:', salt);
        return false;
      }
      
      if (algorithm.toLowerCase() !== 'sha256') {
        console.error('Invalid algorithm:', algorithm);
        return false;
      }
      
      return true;
    } catch (error) {
      console.error('Error validating hashed contact:', error);
      return false;
    }
  }

  prepareForServer(hashedContacts) {
    return hashedContacts
      .filter(contact => this.validateHashedContact(contact))
      .map(contact => ({
        hash: contact.hash,
        salt: contact.salt,
        algorithm: contact.algorithm
      }));
  }
}

// Create singleton instance
const contactHasher = new ContactHasher();

export { contactHasher };
export default contactHasher;