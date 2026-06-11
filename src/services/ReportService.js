import { apiCall } from '../Config/Https';

export async function submitReport(payload) {
  try {
    const response = await apiCall('POST', 'user/monitoring/report', payload);
    if (response?.success || response?.status === 'success' || response?.statusCode === 200 || response?.code === 200) {
      return { success: true, message: response.message || 'Report submitted successfully.', data: response?.data };
    }
    return { success: false, message: response?.message || 'Failed to submit report.' };
  } catch (error) {
    return { success: false, message: error?.message || 'Network error' };
  }
}

// "My Reports" — the reports submitted by the current user.
export async function fetchMyReports({ page = 1, limit = 20, status = '', reportType = '' } = {}) {
  try {
    const response = await apiCall('POST', `user/monitoring/reports/my?page=${page}&limit=${limit}`, { status, reportType });
    if (response?.statusCode === 200 || response?.success) {
      const data = response?.data || {};
      return {
        success: true,
        reports: data.docs || [],
        total: data.total || 0,
        page: data.page || page,
        totalPages: data.totalPages || 1,
      };
    }
    return { success: false, message: response?.message || 'Failed to fetch reports.', reports: [] };
  } catch (error) {
    return { success: false, message: error?.message || 'Network error', reports: [] };
  }
}
