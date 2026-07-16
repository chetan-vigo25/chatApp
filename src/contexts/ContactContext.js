import React, { createContext, useContext, useState } from 'react';
import * as Contacts from 'expo-contacts';
import { suspendAppLock, resumeAppLock } from '../services/appLockGuard';

const ContactContext = createContext();

export const ContactProvider = ({ children }) => {
  const [contacts, setContacts] = useState([]);
  const [permissionStatus, setPermissionStatus] = useState(null);

  const askPermissionAndLoadContacts = async () => {
    // The permission dialog backgrounds the app on many devices — suspend the
    // app lock so fetching contacts doesn't bounce the user to the lock screen.
    suspendAppLock();
    try {
      const { status } = await Contacts.requestPermissionsAsync();
      setPermissionStatus(status);

      if (status === 'granted') {
        const { data } = await Contacts.getContactsAsync({
          fields: [Contacts.Fields.PhoneNumbers],
        });

        const contactsWithNumbers = data.filter(
          contact => contact.phoneNumbers && contact.phoneNumbers.length > 0
        );

        setContacts(contactsWithNumbers);
      }
    } finally {
      resumeAppLock();
    }
  };

  return (
    <ContactContext.Provider value={{ contacts, askPermissionAndLoadContacts, permissionStatus }}>
      {children}
    </ContactContext.Provider>
  );
};

export const useContacts = () => {
  const context = useContext(ContactContext);
  if (!context) {
    throw new Error('useContacts must be used within a ContactsProvider');
  }
  return context;
};
