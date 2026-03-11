import { resetToLogin } from "../navigationService";
import { clearLocalStorageAndDisconnect, emitLogoutCurrentDevice } from "../Socket/socket";

export const handleLogout = async () => {
  try {
    await emitLogoutCurrentDevice();
    await clearLocalStorageAndDisconnect();
    resetToLogin(); // navigate to login
  } catch (error) {
    console.error("Error during logout:", error);
  }
};