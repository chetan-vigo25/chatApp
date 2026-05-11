import React, { useState, useCallback, useRef } from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  StyleSheet,
  Modal,
  FlatList,
  TextInput,
  Animated,
  Platform,
  Keyboard,
} from 'react-native';
import { useTheme } from '../contexts/ThemeContext';
import countryCodes from '../jsonFile/countryCodes.json';
import { Ionicons } from '@expo/vector-icons';

const CountryCodeContact = ({
  selectedCountry = countryCodes[0],
  onCountrySelect,
  style = {},
  disabled = false,
  placeholder = "Select Country",
  showFlag = true,
  showCode = true,
  showName = true,
}) => {
  const { theme, isDarkMode } = useTheme();
  const [showModal, setShowModal] = useState(false);
  const [search, setSearch] = useState('');
  const slideAnim = useRef(new Animated.Value(0)).current;
  const backdropAnim = useRef(new Animated.Value(0)).current;

  const openModal = () => {
    if (disabled) return;
    setShowModal(true);
    setSearch('');
    Animated.parallel([
      Animated.timing(backdropAnim, {
        toValue: 1,
        duration: 280,
        useNativeDriver: true,
      }),
      Animated.spring(slideAnim, {
        toValue: 1,
        damping: 20,
        stiffness: 180,
        mass: 1,
        useNativeDriver: true,
      }),
    ]).start();
  };

  const closeModal = () => {
    Keyboard.dismiss();
    Animated.parallel([
      Animated.timing(backdropAnim, {
        toValue: 0,
        duration: 200,
        useNativeDriver: true,
      }),
      Animated.timing(slideAnim, {
        toValue: 0,
        duration: 220,
        useNativeDriver: true,
      }),
    ]).start(() => {
      setShowModal(false);
      setSearch('');
    });
  };

  const handleCountrySelect = (country) => {
    if (onCountrySelect) {
      onCountrySelect(country);
    }
    closeModal();
  };

  const filteredCountries = search.trim()
    ? countryCodes.filter(
        (c) =>
          c.name.toLowerCase().includes(search.toLowerCase()) ||
          c.code.includes(search)
      )
    : countryCodes;

  const renderCountryItem = ({ item }) => {
    const isSelected = selectedCountry?.code === item.code && selectedCountry?.name === item.name;
    return (
      <TouchableOpacity
        activeOpacity={0.6}
        style={[
          styles.countryItem,
          {
            backgroundColor: isSelected
              ? (isDarkMode ? 'rgba(52,183,241,0.12)' : 'rgba(52,183,241,0.08)')
              : 'transparent',
          },
        ]}
        onPress={() => handleCountrySelect(item)}
      >
        <Text style={styles.countryFlag}>{item.flag}</Text>
        <View style={styles.countryInfo}>
          <Text
            style={[styles.countryName, { color: theme.colors.primaryTextColor }]}
            numberOfLines={1}
          >
            {item.name}
          </Text>
          <Text
            style={[styles.countryCode, { color: theme.colors.placeHolderTextColor }]}
          >
            {item.code}
          </Text>
        </View>
        {isSelected && (
          <Ionicons name="checkmark-circle" size={20} color={theme.colors.themeColor} />
        )}
      </TouchableOpacity>
    );
  };

  const ItemSeparator = useCallback(() => (
    <View style={[styles.separator, { backgroundColor: isDarkMode ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.06)' }]} />
  ), [isDarkMode]);

  return (
    <>
      <TouchableOpacity
        onPress={openModal}
        disabled={disabled}
        activeOpacity={0.7}
        style={{ width: 60, height: 52, justifyContent: 'center', alignItems: 'center' }}
      >
        <Text style={{ fontFamily: 'Roboto-Regular', fontSize: 14, color: theme.colors.primaryTextColor }}>
          {selectedCountry?.code || ''}
        </Text>
      </TouchableOpacity>

      <Modal
        visible={showModal}
        animationType="none"
        transparent={true}
        onRequestClose={closeModal}
        statusBarTranslucent
      >
        <View style={styles.modalWrapper}>
          <Animated.View
            style={[
              styles.backdrop,
              { opacity: backdropAnim.interpolate({ inputRange: [0, 1], outputRange: [0, 1] }) },
            ]}
          >
            <TouchableOpacity style={styles.backdropTouch} activeOpacity={1} onPress={closeModal} />
          </Animated.View>

          <Animated.View
            style={[
              styles.modalSheet,
              {
                backgroundColor: isDarkMode ? '#1B2733' : '#FFFFFF',
                transform: [
                  {
                    translateY: slideAnim.interpolate({
                      inputRange: [0, 1],
                      outputRange: [600, 0],
                    }),
                  },
                ],
              },
            ]}
          >
            {/* Handle bar */}
            <View style={styles.handleBarRow}>
              <View style={[styles.handleBar, { backgroundColor: isDarkMode ? 'rgba(255,255,255,0.2)' : 'rgba(0,0,0,0.15)' }]} />
            </View>

            {/* Header */}
            <View style={styles.modalHeader}>
              <Text style={[styles.modalTitle, { color: theme.colors.primaryTextColor }]}>
                Select Country
              </Text>
              <TouchableOpacity
                onPress={closeModal}
                activeOpacity={0.7}
                style={[styles.closeBtn, { backgroundColor: isDarkMode ? 'rgba(255,255,255,0.1)' : 'rgba(0,0,0,0.06)' }]}
              >
                <Ionicons name="close" size={18} color={theme.colors.primaryTextColor} />
              </TouchableOpacity>
            </View>

            {/* Search */}
            <View style={[styles.searchContainer, { backgroundColor: isDarkMode ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.04)' }]}>
              <Ionicons name="search" size={18} color={theme.colors.placeHolderTextColor} style={{ marginRight: 8 }} />
              <TextInput
                style={[styles.searchInput, { color: theme.colors.primaryTextColor }]}
                placeholder="Search country or code..."
                placeholderTextColor={theme.colors.placeHolderTextColor}
                value={search}
                onChangeText={setSearch}
                autoCorrect={false}
                autoCapitalize="none"
                returnKeyType="search"
              />
              {search.length > 0 && (
                <TouchableOpacity onPress={() => setSearch('')} activeOpacity={0.7}>
                  <Ionicons name="close-circle" size={18} color={theme.colors.placeHolderTextColor} />
                </TouchableOpacity>
              )}
            </View>

            {/* List */}
            <FlatList
              data={filteredCountries}
              keyExtractor={(item) => `${item.code}-${item.name}`}
              renderItem={renderCountryItem}
              ItemSeparatorComponent={ItemSeparator}
              style={styles.countryList}
              contentContainerStyle={styles.listContent}
              showsVerticalScrollIndicator={false}
              keyboardShouldPersistTaps="handled"
              initialNumToRender={20}
              maxToRenderPerBatch={15}
              windowSize={7}
              ListEmptyComponent={
                <View style={styles.emptyContainer}>
                  <Ionicons name="earth" size={48} color={theme.colors.placeHolderTextColor} />
                  <Text style={[styles.emptyText, { color: theme.colors.placeHolderTextColor }]}>
                    No countries found
                  </Text>
                </View>
              }
            />
          </Animated.View>
        </View>
      </Modal>
    </>
  );
};

const styles = StyleSheet.create({
  modalWrapper: {
    flex: 1,
    justifyContent: 'flex-end',
  },
  backdrop: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(0,0,0,0.5)',
  },
  backdropTouch: {
    flex: 1,
  },
  modalSheet: {
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
    maxHeight: '75%',
    minHeight: '55%',
    overflow: 'hidden',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: -3 },
    shadowOpacity: 0.15,
    shadowRadius: 12,
    elevation: 20,
  },
  handleBarRow: {
    alignItems: 'center',
    paddingTop: 10,
    paddingBottom: 4,
  },
  handleBar: {
    width: 36,
    height: 4,
    borderRadius: 2,
  },
  modalHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 20,
    paddingTop: 8,
    paddingBottom: 12,
  },
  modalTitle: {
    fontSize: 18,
    fontFamily: 'Roboto-SemiBold',
  },
  closeBtn: {
    width: 32,
    height: 32,
    borderRadius: 16,
    justifyContent: 'center',
    alignItems: 'center',
  },
  searchContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    marginHorizontal: 16,
    marginBottom: 8,
    borderRadius: 12,
    paddingHorizontal: 12,
    height: 42,
  },
  searchInput: {
    flex: 1,
    fontFamily: 'Roboto-Regular',
    fontSize: 14,
    paddingVertical: 0,
  },
  countryList: {
    flex: 1,
  },
  listContent: {
    paddingBottom: Platform.OS === 'ios' ? 34 : 16,
  },
  countryItem: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 20,
    paddingVertical: 13,
  },
  countryFlag: {
    fontSize: 26,
    marginRight: 14,
  },
  countryInfo: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginRight: 8,
  },
  countryName: {
    fontSize: 15,
    fontFamily: 'Roboto-Regular',
    flex: 1,
  },
  countryCode: {
    fontSize: 14,
    fontFamily: 'Roboto-Medium',
    marginLeft: 8,
  },
  separator: {
    height: 1,
    marginLeft: 60,
  },
  emptyContainer: {
    alignItems: 'center',
    justifyContent: 'center',
    paddingTop: 60,
    gap: 12,
  },
  emptyText: {
    fontSize: 15,
    fontFamily: 'Roboto-Medium',
  },
});

export default CountryCodeContact;