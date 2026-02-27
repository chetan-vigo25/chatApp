import CryptoJS from 'crypto-js';
import { SALT_SECRET, CONTACT_SALT } from '@env';

class ContactHasher {
  constructor() {
    this.algorithm = 'sha256';
    this.saltLength = 32;
  }
 
  generateSalt() {
    try {
      return CryptoJS.lib.WordArray.random(this.saltLength).toString();
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

  // Simple encryption without complex EVP (more reliable)
  encryptContent(plainText) {
    if (!plainText) return "";
    try {
      // Use simple AES encryption with the CONTACT_SALT as key
      const key = CryptoJS.enc.Utf8.parse(String(CONTACT_SALT || 'default_salt_123').padEnd(32, '0').substring(0, 32));
      const iv = CryptoJS.lib.WordArray.random(16);
      
      const encrypted = CryptoJS.AES.encrypt(plainText, key, {
        iv: iv,
        mode: CryptoJS.mode.CBC,
        padding: CryptoJS.pad.Pkcs7
      });

      // Combine IV and ciphertext
      const combined = iv.concat(encrypted.ciphertext);
      return CryptoJS.enc.Base64.stringify(combined);
    } catch (err) {
      console.error('Error encrypting content:', err);
      return "";
    }
  }

  // Simple decryption
  decryptContent(cipherText) {
    if (!cipherText) return "";
    try {
      const key = CryptoJS.enc.Utf8.parse(String(CONTACT_SALT || 'default_salt_123').padEnd(32, '0').substring(0, 32));
      
      // Parse the combined IV and ciphertext
      const combined = CryptoJS.enc.Base64.parse(cipherText);
      
      // Extract IV (first 16 bytes) and ciphertext
      const iv = CryptoJS.lib.WordArray.create(combined.words.slice(0, 4), 16);
      const ciphertext = CryptoJS.lib.WordArray.create(combined.words.slice(4));
      
      const decrypted = CryptoJS.AES.decrypt(
        { ciphertext: ciphertext },
        key,
        { iv: iv, mode: CryptoJS.mode.CBC, padding: CryptoJS.pad.Pkcs7 }
      );
      
      return decrypted.toString(CryptoJS.enc.Utf8);
    } catch (err) {
      console.error('Error decrypting content:', err);
      return "";
    }
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