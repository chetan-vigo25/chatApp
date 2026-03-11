import { configureStore } from '@reduxjs/toolkit';
import rootReducer from './RootReducers';

const store = configureStore({
  reducer: rootReducer,
});

export { store };
export default store;