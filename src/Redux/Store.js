import { configureStore } from '@reduxjs/toolkit';
import rootReducer from './RootReducers';

const store = configureStore({
  reducer: rootReducer,
  middleware: (getDefaultMiddleware) =>
    getDefaultMiddleware({
      // Media uploads dispatch FormData plus an onUploadProgress callback via
      // the chat/mediaUpload thunk arg — intentionally non-serializable.
      serializableCheck: {
        ignoredActionPaths: ['meta.arg', 'meta.arg.formData', 'meta.arg.onUploadProgress'],
      },
    }),
});

export { store };
export default store;
