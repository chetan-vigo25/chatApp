import { apiCall } from '../../../Config/Https';
import countryCodes from '../../../jsonFile/countryCodes.json';

/**
 * Fetch the admin-controlled list of countries allowed for phone login.
 *
 * The backend (GET /api/v2/app/allowed-countries) returns the allowlist
 * resolved to full country objects ({ iso, code, name, flag, region }) — the
 * same shape the bundled countryCodes.json uses, so the picker consumes it
 * directly. This is a pre-auth call, so it never blocks the login screen: on
 * any failure (offline, server down) we fall back to the bundled full list.
 *
 * @returns {Promise<Array<{code:string,name:string,flag?:string,region?:string}>>}
 */
export const getAllowedCountries = async () => {
  try {
    const res = await apiCall('GET', 'app/allowed-countries', {}, {
      silent: true,
      retryOnNetwork: true,
    });
    const list = res?.data;
    if (Array.isArray(list)) {
      const clean = list.filter((c) => c && c.code && c.name);
      if (clean.length) return clean;
    }
  } catch (e) {
    // Ignore — fall back to the bundled catalogue below.
  }
  return countryCodes;
};

export default getAllowedCountries;
