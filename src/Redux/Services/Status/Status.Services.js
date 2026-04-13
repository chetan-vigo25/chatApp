import { apiCall, apiCallForm } from "../../../Config/Https";
import { Alert } from "react-native";

const showToast = (msg) => { if (msg) Alert.alert('', msg); };
const BASE = "user/status";

export const statusServices = {
  async createStatus(data) {
    const response = await apiCall("POST", `${BASE}/create`, data);
    if (response?.statusCode === 200) return response;
    showToast(response?.message || "Failed to create status");
    return Promise.reject(response?.message);
  },

  async getMyStatuses() {
    const response = await apiCall("POST", `${BASE}/my`);
    if (response?.statusCode === 200) return response;
    return { data: [] };
  },

  async getContactStatuses() {
    const response = await apiCall("POST", `${BASE}/contacts`);
    if (response?.statusCode === 200) return response;
    return { data: [] };
  },

  async viewStatus(statusId) {
    const response = await apiCall("POST", `${BASE}/view`, { statusId });
    if (response?.statusCode === 200) return response;
    return Promise.reject(response?.message);
  },

  async getStatusViewers(statusId) {
    const response = await apiCall("POST", `${BASE}/viewers`, { statusId });
    if (response?.statusCode === 200) return response;
    return { data: { viewCount: 0, viewers: [] } };
  },

  async deleteStatus(statusId) {
    const response = await apiCall("POST", `${BASE}/delete`, { statusId });
    if (response?.statusCode === 200) return response;
    showToast(response?.message || "Failed to delete");
    return Promise.reject(response?.message);
  },

  async createMediaStatus(formData) {
    const response = await apiCallForm("POST", "user/media/upload", formData);
    if (response?.statusCode === 200) return response;
    return Promise.reject(response?.message);
  },
};
