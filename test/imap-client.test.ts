/**
 * Unit tests for IMAP client
 * 
 * Tests the IMAP connection manager functionality including connection
 * establishment, credential validation, and error handling.
 */

import { connectIMAP, validateCredentials } from '../lambda/migration/imap-client';
import { IMAPCredentials, MigrationErrorType } from '../lambda/migration/types';

// Mock imap-simple module
jest.mock('imap-simple');
import * as imaps from 'imap-simple';

describe('IMAP Client', () => {
  describe('connectIMAP', () => {
    it('should connect with valid TLS configuration', async () => {
      const mockConnection = {
        openBox: jest.fn(),
        end: jest.fn(),
      };
      
      (imaps.connect as jest.Mock).mockResolvedValue(mockConnection);
      
      const credentials: IMAPCredentials = {
        server: 'imap.example.com',
        port: 993,
        username: 'test@example.com',
        password: 'password123',
        useTLS: true,
      };
      
      const connection = await connectIMAP(credentials);
      
      expect(imaps.connect).toHaveBeenCalledWith({
        imap: {
          user: 'test@example.com',
          password: 'password123',
          host: 'imap.example.com',
          port: 993,
          tls: true,
          tlsOptions: {
            rejectUnauthorized: true,
            minVersion: 'TLSv1.2',
          },
          connTimeout: 30000,
          authTimeout: 30000,
        },
      });
      
      expect(connection).toBe(mockConnection);
    });
    
    it('should throw descriptive error for authentication failure', async () => {
      const authError = new Error('Authentication failed');
      (authError as any).code = 'EAUTH';
      
      (imaps.connect as jest.Mock).mockRejectedValue(authError);
      
      const credentials: IMAPCredentials = {
        server: 'imap.example.com',
        port: 993,
        username: 'test@example.com',
        password: 'wrong-password',
        useTLS: true,
      };
      
      await expect(connectIMAP(credentials)).rejects.toThrow(
        'Authentication failed: Invalid username or password'
      );
    });
    
    it('should throw descriptive error for connection refused', async () => {
      const connError = new Error('Connection refused');
      (connError as any).code = 'ECONNREFUSED';
      
      (imaps.connect as jest.Mock).mockRejectedValue(connError);
      
      const credentials: IMAPCredentials = {
        server: 'imap.example.com',
        port: 993,
        username: 'test@example.com',
        password: 'password123',
        useTLS: true,
      };
      
      await expect(connectIMAP(credentials)).rejects.toThrow(
        'Connection refused: Check server and port'
      );
    });
    
    it('should throw descriptive error for server not found', async () => {
      const notFoundError = new Error('Server not found');
      (notFoundError as any).code = 'ENOTFOUND';
      
      (imaps.connect as jest.Mock).mockRejectedValue(notFoundError);
      
      const credentials: IMAPCredentials = {
        server: 'invalid.example.com',
        port: 993,
        username: 'test@example.com',
        password: 'password123',
        useTLS: true,
      };
      
      await expect(connectIMAP(credentials)).rejects.toThrow(
        'Server not found: invalid.example.com'
      );
    });
    
    it('should throw descriptive error for connection timeout', async () => {
      const timeoutError = new Error('Connection timeout');
      (timeoutError as any).code = 'ETIMEDOUT';
      
      (imaps.connect as jest.Mock).mockRejectedValue(timeoutError);
      
      const credentials: IMAPCredentials = {
        server: 'imap.example.com',
        port: 993,
        username: 'test@example.com',
        password: 'password123',
        useTLS: true,
      };
      
      await expect(connectIMAP(credentials)).rejects.toThrow(
        'Connection timeout: Server is unreachable'
      );
    });
  });
  
  describe('validateCredentials', () => {
    it('should return valid=true for successful connection', async () => {
      const mockConnection = {
        openBox: jest.fn().mockResolvedValue({}),
        end: jest.fn().mockResolvedValue(undefined),
      };
      
      (imaps.connect as jest.Mock).mockResolvedValue(mockConnection);
      
      const credentials: IMAPCredentials = {
        server: 'imap.example.com',
        port: 993,
        username: 'test@example.com',
        password: 'password123',
        useTLS: true,
      };
      
      const result = await validateCredentials(credentials);
      
      expect(result.valid).toBe(true);
      expect(result.error).toBeUndefined();
      expect(mockConnection.openBox).toHaveBeenCalledWith('INBOX', true);
      expect(mockConnection.end).toHaveBeenCalled();
    });
    
    it('should return valid=false with AUTH_ERROR for authentication failure', async () => {
      const authError = new Error('Authentication failed: Invalid username or password');
      (imaps.connect as jest.Mock).mockRejectedValue(authError);
      
      const credentials: IMAPCredentials = {
        server: 'imap.example.com',
        port: 993,
        username: 'test@example.com',
        password: 'wrong-password',
        useTLS: true,
      };
      
      const result = await validateCredentials(credentials);
      
      expect(result.valid).toBe(false);
      expect(result.error).toBe('Authentication failed: Invalid username or password');
      expect(result.errorType).toBe(MigrationErrorType.AUTH_ERROR);
    });
    
    it('should return valid=false with CONNECTION_ERROR for connection refused', async () => {
      const connError = new Error('Connection refused: Check server and port');
      (imaps.connect as jest.Mock).mockRejectedValue(connError);
      
      const credentials: IMAPCredentials = {
        server: 'imap.example.com',
        port: 993,
        username: 'test@example.com',
        password: 'password123',
        useTLS: true,
      };
      
      const result = await validateCredentials(credentials);
      
      expect(result.valid).toBe(false);
      expect(result.error).toBe('Connection refused: Check server and port');
      expect(result.errorType).toBe(MigrationErrorType.CONNECTION_ERROR);
    });
    
    it('should close connection even if openBox fails', async () => {
      const mockConnection = {
        openBox: jest.fn().mockRejectedValue(new Error('INBOX not found')),
        end: jest.fn().mockResolvedValue(undefined),
      };
      
      (imaps.connect as jest.Mock).mockResolvedValue(mockConnection);
      
      const credentials: IMAPCredentials = {
        server: 'imap.example.com',
        port: 993,
        username: 'test@example.com',
        password: 'password123',
        useTLS: true,
      };
      
      const result = await validateCredentials(credentials);
      
      expect(result.valid).toBe(false);
      expect(mockConnection.end).toHaveBeenCalled();
    });
  });
});
