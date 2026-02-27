import React, { createContext, useContext, useState } from 'react';
import * as Contacts from 'expo-contacts';

const ContactContext = createContext();

export const ContactProvider = ({ children }) => {
  const [contacts, setContacts] = useState([]);
  const [permissionStatus, setPermissionStatus] = useState(null);

  const askPermissionAndLoadContacts = async () => {
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
