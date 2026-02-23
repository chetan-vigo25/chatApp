import AsyncStorage from "@react-native-async-storage/async-storage";
import { store } from "../../../Redux/Store"; // your redux store
import { logout } from "../../../Redux/Reducer/Auth/Auth.reducer";
import { resetToLogin } from "../navigationService";

export const handleLogout = async () => {
  try {
    await AsyncStorage.removeItem("accessToken");
    store.dispatch(logout()); // dispatch redux logout
    resetToLogin(); // navigate to login
  } catch (error) {
    console.error("Error during logout:", error);
  }
};
