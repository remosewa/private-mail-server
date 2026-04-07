/**
 * Axios instance shared by all API modules.
 *
 * - Injects the Cognito access token from authStore on every request.
 * - On 401 responses, attempts to refresh the token before clearing auth.
 */

import axios from 'axios';
import { useAuthStore } from '../store/authStore';
import { refreshTokens } from './auth';

export const apiClient = axios.create({
  baseURL: import.meta.env['VITE_API_URL'] as string,
  headers: { 'Content-Type': 'application/json' },
});

apiClient.interceptors.request.use(config => {
  const token = useAuthStore.getState().accessToken;
  if (token) {
    config.headers['Authorization'] = `Bearer ${token}`;
  }
  return config;
});

let isRefreshing = false;
let refreshPromise: Promise<unknown> | null = null;

apiClient.interceptors.response.use(
  res => res,
  async err => {
    if (axios.isAxiosError(err)) {
      if (err.response?.status === 401) {
        const { username, refreshToken: currentRefreshToken } = useAuthStore.getState();

        if (username && currentRefreshToken) {
          // Start a refresh if one isn't already in flight.
          if (!isRefreshing) {
            isRefreshing = true;
            refreshPromise = (async () => {
              try {
                const tokens = await refreshTokens(username, currentRefreshToken);
                useAuthStore.getState().updateTokens(tokens);
                return tokens;
              } catch (refreshError) {
                useAuthStore.getState().clearAuth();
                throw refreshError;
              } finally {
                isRefreshing = false;
                refreshPromise = null;
              }
            })();
          }

          // All concurrent 401s wait for the same in-flight refresh.
          try {
            const tokens = await refreshPromise as { accessToken: string };
            if (err.config) {
              err.config.headers['Authorization'] = `Bearer ${tokens.accessToken}`;
              return await apiClient.request(err.config);
            }
          } catch {
            // Refresh failed — auth was already cleared above.
          }
        } else {
          // No credentials at all — nothing to refresh.
          useAuthStore.getState().clearAuth();
        }
      }
      
      // Unwrap the server's { error: "..." } body so callers get a useful message
      const serverMessage = (err.response?.data as { error?: string } | undefined)?.error;
      if (serverMessage) {
        err.message = serverMessage;
      }
    }
    return Promise.reject(err);
  },
);
