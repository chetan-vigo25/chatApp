import { apiCall } from '../Config/Https';

export async function submitReport(payload) {
  console.log('/user/monitoring/report',payload)
  try {
    const response = await apiCall('POST', 'user/monitoring/report', payload);
    console.log('submitReport API response:', JSON.stringify(response));
    if (response?.success || response?.status === 'success' || response?.statusCode === 200 || response?.code === 200) {
      return { success: true, message: response.message || 'Report submitted successfully.' };
    }
    return { success: false, message: response?.message || 'Failed to submit report.' };
  } catch (error) {
    console.log('submitReport API error:', error);
    return { success: false, message: error?.message || 'Network error' };
  }
}
