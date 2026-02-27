// Complete dedupe logic for messages using serverMessageId, id, tempId
export function deduplicateMessages(messagesArray) {
    const map = new Map();
  
    messagesArray.forEach(msg => {
      const key = msg?.serverMessageId || msg?.id || msg?.tempId;
      if (!key) return;
  
      if (!map.has(key)) {
        map.set(key, msg);
      } else {
        // Pick the "best" version: self-sent with localUri, else latest timestamp
        const existing = map.get(key);
        const isThisLocal = !!msg?.localUri;
        const isExistingLocal = !!existing?.localUri;
        if (isThisLocal && !isExistingLocal) { map.set(key, msg); }
        else if ((msg.timestamp || 0) > (existing.timestamp || 0)) { map.set(key, msg); }
      }
    });
  
    // Return newest first
    return Array.from(map.values()).sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
  }