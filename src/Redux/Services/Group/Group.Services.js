import { apiCall, apiCallForm } from '../../../Config/Https';
import { Alert, ToastAndroid, Platform } from 'react-native';

function showToast(message) {
  if (Platform.OS === 'android') {
    ToastAndroid.show(message, ToastAndroid.SHORT);
  } else {
    Alert.alert('', message);
  }
}

// ============================================
// CREATE GROUP
// ============================================
export async function createGroup(payload) {
  try {
    const response = await apiCall('POST', 'user/group/create', payload);
    if (response?.statusCode === 200 || response?.statusCode === 201) {
      return response;
    }
    showToast(response?.message || 'Failed to create group');
    return Promise.reject(response?.message || 'Failed to create group');
  } catch (error) {
    console.error('group/create error:', error);
    return Promise.reject(error);
  }
}

// ============================================
// UPDATE GROUP
// ============================================
export async function updateGroup(payload) {
  try {
    const response = await apiCall('POST', 'user/group/update', payload);
    if (response?.statusCode === 200) {
      return response;
    }
    showToast(response?.message || 'Failed to update group');
    return Promise.reject(response?.message || 'Failed to update group');
  } catch (error) {
    console.error('group/update error:', error);
    return Promise.reject(error);
  }
}

// ============================================
// VIEW GROUP
// ============================================
export async function viewGroup(payload) {
  try {
    const response = await apiCall('POST', 'user/group/view', payload);
    if (response?.statusCode === 200) {
      return response;
    }
    showToast(response?.message || 'Failed to fetch group');
    return Promise.reject(response?.message || 'Failed to fetch group');
  } catch (error) {
    console.error('group/view error:', error);
    return Promise.reject(error);
  }
}

// ============================================
// DELETE GROUP
// ============================================
export async function deleteGroup(payload) {
  try {
    const response = await apiCall('POST', 'user/group/delete-group', payload);
    if (response?.statusCode === 200) {
      return response;
    }
    showToast(response?.message || 'Failed to delete group');
    return Promise.reject(response?.message || 'Failed to delete group');
  } catch (error) {
    console.error('group/delete-group error:', error);
    return Promise.reject(error);
  }
}

// ============================================
// EXIT GROUP
// ============================================
export async function exitGroup(payload) {
  try {
    const response = await apiCall('POST', 'user/group/exit', payload);
    if (response?.statusCode === 200) {
      return response;
    }
    showToast(response?.message || 'Failed to exit group');
    return Promise.reject(response?.message || 'Failed to exit group');
  } catch (error) {
    console.error('group/exit error:', error);
    return Promise.reject(error);
  }
}

// ============================================
// LEAVE ALL GROUPS
// ============================================
export async function leaveAllGroups() {
  try {
    const response = await apiCall('POST', 'user/group/leave-all', {});
    if (response?.statusCode === 200) {
      return response;
    }
    showToast(response?.message || 'Failed to leave all groups');
    return Promise.reject(response?.message || 'Failed to leave all groups');
  } catch (error) {
    console.error('group/leave-all error:', error);
    return Promise.reject(error);
  }
}

// ============================================
// TRANSFER OWNERSHIP
// ============================================
export async function transferOwnership(payload) {
  try {
    const response = await apiCall('POST', 'user/group/transfer-owner', payload);
    if (response?.statusCode === 200) {
      return response;
    }
    showToast(response?.message || 'Failed to transfer ownership');
    return Promise.reject(response?.message || 'Failed to transfer ownership');
  } catch (error) {
    console.error('group/transfer-owner error:', error);
    return Promise.reject(error);
  }
}

// ============================================
// ADD MEMBERS
// ============================================
export async function addMembers(payload) {
  try {
    const response = await apiCall('POST', 'user/group/add-members', payload);
    if (response?.statusCode === 200) {
      return response;
    }
    showToast(response?.message || 'Failed to add members');
    return Promise.reject(response?.message || 'Failed to add members');
  } catch (error) {
    console.error('group/add-members error:', error);
    return Promise.reject(error);
  }
}

// ============================================
// REMOVE MEMBER
// ============================================
export async function removeMember(payload) {
  try {
    const response = await apiCall('POST', 'user/group/remove-member', payload);
    if (response?.statusCode === 200) {
      return response;
    }
    showToast(response?.message || 'Failed to remove member');
    return Promise.reject(response?.message || 'Failed to remove member');
  } catch (error) {
    console.error('group/remove-member error:', error);
    return Promise.reject(error);
  }
}

// ============================================
// UPLOAD GROUP AVATAR
// ============================================
export async function uploadGroupAvatar(formData) {
  try {
    const response = await apiCallForm('POST', 'user/group/avatar', formData);
    if (response?.statusCode === 200) {
      return response;
    }
    showToast(response?.message || 'Failed to upload avatar');
    return Promise.reject(response?.message || 'Failed to upload avatar');
  } catch (error) {
    console.error('group/avatar error:', error);
    return Promise.reject(error);
  }
}

// Export as groupServices object
export const groupServices = {
  createGroup,
  updateGroup,
  viewGroup,
  deleteGroup,
  exitGroup,
  leaveAllGroups,
  transferOwnership,
  addMembers,
  removeMember,
  uploadGroupAvatar,
};

export default groupServices;