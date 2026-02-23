import React, { useState } from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  StyleSheet,
  Modal,
  FlatList,
} from 'react-native';
import { useTheme } from '../contexts/ThemeContext';
import countryCodes from '../jsonFile/countryCodes.json';
import AsyncStorage from '@react-native-async-storage/async-storage';

const CountryCodeSelector = ({
  selectedCountry = countryCodes[0], // Default to India
  onCountrySelect,
  style = {},
  disabled = false,
  placeholder = "Select Country",
  showFlag = true,
  showCode = true,
  showName = true,
}) => {
  const { theme } = useTheme();
  const [showModal, setShowModal] = useState(false);

  const handleCountrySelect = (country) => {
    if (onCountrySelect) {
      onCountrySelect(country);
    }
    setShowModal(false);
  };

  const renderCountryItem = ({ item }) => (
    <TouchableOpacity
      style={[styles.countryItem, { borderBottomColor: theme.colors.borderColor }]}
      onPress={() => handleCountrySelect(item)}
    >
      {showFlag && <Text style={styles.countryFlag}>{item.flag}</Text>}
      <View style={styles.countryInfo}>
        {showCode && (
          <Text style={[styles.countryCode, { color: theme.colors.primaryTextColor, marginRight: 10 }]}>
            {item.code}
          </Text>
        )}
        <Text style={[styles.countryName, { color: theme.colors.primaryTextColor, }]}>
          {item.name}
        </Text>
      </View>
    </TouchableOpacity>
  );

  const getDisplayText = () => {
    if (!selectedCountry) {
      return placeholder;
    }
    if (showName && showCode) {
      return `${selectedCountry.name} (${selectedCountry.code})`;
    }
    if (showName) {
      return selectedCountry.name;
    }
    if (showCode) {
      return selectedCountry.code;
    }
    return placeholder;
  };

  return (
    <>
      <View style={{ width:'50%', height:40, marginTop:40, flexDirection:'row', justifyContent:'space-between', borderBottomWidth:1.5, borderColor: theme.colors.themeColor, alignSelf:'center',}} >
        <View style={{ flex:1, alignItems:'center', justifyContent:'center', }} >
          <Text style={{ fontFamily: 'Poppins-Regular', fontSize: 14, color: theme.colors.primaryTextColor }} >{selectedCountry?.name || placeholder}</Text>
        </View>
        <TouchableOpacity onPress={() => !disabled && setShowModal(true)} style={{ width:20, height:40, alignItems:'center', justifyContent:'center', }} >
         <Text style={[styles.dropdownArrow, { color: theme.colors.themeColor }]}>
            ▼
          </Text>
        </TouchableOpacity>
      </View>
      {/* <TouchableOpacity
        style={[
          { 
            backgroundColor: 'red',
            width: 60,
            height: 50,
            borderColor: '#000',
            opacity: disabled ? 0.6 : 1,
            justifyContent: 'center',
          },
        ]}
        onPress={() => !disabled && setShowModal(true)}
        disabled={disabled}
      >
        <View style={styles.selectorContent}>
          <Text style={[styles.selectorText, { color: "#000"}]}>
            {getDisplayText()}
          </Text>
          <Text style={[styles.dropdownArrow, { color: theme.colors.themeColor }]}>
            ▼
          </Text>
        </View>
      </TouchableOpacity> */}

      {/* Country Selection Modal */}
      <Modal
        visible={showModal}
        animationType="slide"
        transparent={true}
        onRequestClose={() => setShowModal(false)}
      >
        <View style={styles.modalOverlay}>
          <View style={[styles.modalContent, { backgroundColor: theme.colors.background }]}>
            <View style={[styles.modalHeader, { borderBottomColor: theme.colors.borderColor }]}>
              <Text style={[styles.modalTitle, { color: theme.colors.primaryTextColor }]}>
                Select Country
              </Text>
              <TouchableOpacity
                onPress={() => setShowModal(false)}
                style={[
                  styles.closeButton,
                  { backgroundColor: theme.colors.themeColor }
                ]}
              >
                <Text style={[styles.closeButtonText, { color: theme.colors.textWhite }]}>
                  ✕
                </Text>
              </TouchableOpacity>
            </View>
            
            <FlatList
              data={countryCodes}
              keyExtractor={(item) => item.code}
              renderItem={renderCountryItem}
              style={styles.countryList}
              showsVerticalScrollIndicator={false}
            />
          </View>
        </View>
      </Modal>
    </>
  );
};

const styles = StyleSheet.create({
  selectorContent: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  flagEmoji: {
    fontSize: 18,
    marginRight: 8,
  },
  selectorText: {
    flex: 1,
    fontSize: 16,
    fontWeight: '500',
  },
  dropdownArrow: {
    fontSize: 16,
  },
  modalOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0, 0, 0, 0.5)',
    justifyContent: 'flex-end',
  },
  modalContent: {
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    maxHeight: '70%',
    minHeight: '60%',
  },
  modalHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 20,
    paddingVertical: 16,
    borderBottomWidth: 1,
  },
  modalTitle: {
    fontSize: 18,
    fontFamily: 'Poppins-Medium',
  },
  closeButton: {
    width: 30,
    height: 30,
    borderRadius: 15,
    justifyContent: 'center',
    alignItems: 'center',
  },
  closeButtonText: {
    fontSize: 16,
    fontWeight: 'bold',
  },
  countryList: {
    flex: 1,
  },
  countryItem: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 20,
    paddingVertical: 12,
    borderBottomWidth: 1,
  },
  countryFlag: {
    fontSize: 24,
    marginRight: 12,
  },
  countryInfo: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
  },
  countryName: {
    fontSize: 14,
    fontFamily: 'Poppins-Regular',
    marginBottom: 2,
  },
  countryCode: {
    fontSize: 14,
  },
});

export default CountryCodeSelector;
