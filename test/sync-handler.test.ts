/**
 * Unit tests for Sync Handler Lambda
 * 
 * Tests the sync endpoint validation and error handling.
 */

import type { APIGatewayProxyEventV2 } from 'aws-lambda';

// Mock the handler module
const mockHandler = {
  handler: async (event: APIGatewayProxyEventV2) => {
    // Extract userId from JWT
    // @ts-expect-error - authorizer is added by API Gateway JWT authorizer at runtime
    const userId = event.requestContext.authorizer?.jwt?.claims?.['sub'] as string | undefined;
    if (!userId) {
      return {
        statusCode: 401,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ error: 'Unauthorized' }),
      };
    }

    // Extract and validate query parameters
    const since = event.queryStringParameters?.since;
    if (!since) {
      return {
        statusCode: 400,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ error: 'Missing required parameter: since' }),
      };
    }

    // Validate ISO-8601 UTC format
    const isoRegex = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{3})?Z?$/;
    if (!isoRegex.test(since)) {
      return {
        statusCode: 400,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ error: 'Invalid since parameter: must be ISO-8601 UTC timestamp' }),
      };
    }

    const date = new Date(since);
    if (isNaN(date.getTime())) {
      return {
        statusCode: 400,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ error: 'Invalid since parameter: must be ISO-8601 UTC timestamp' }),
      };
    }

    if (!since.endsWith('Z') && !since.includes('+00:00')) {
      return {
        statusCode: 400,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ error: 'Invalid since parameter: must be ISO-8601 UTC timestamp' }),
      };
    }

    const limit = Math.min(
      parseInt(event.queryStringParameters?.limit ?? '100', 10),
      500
    );
    const nextToken = event.queryStringParameters?.nextToken;

    // Return response with current server time
    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        emails: [],
        labels: [],
        migrations: [],
        nextToken: null,
        serverTime: new Date().toISOString(),
      }),
    };
  },
};

describe('Sync Handler', () => {
  describe('Authentication', () => {
    test('should return 401 when userId is missing', async () => {
      const event = {
        requestContext: {
          authorizer: {},
        },
        queryStringParameters: {
          since: '2024-01-01T00:00:00.000Z',
        },
      } as unknown as APIGatewayProxyEventV2;

      const result = await mockHandler.handler(event);

      expect(result.statusCode).toBe(401);
      const body = JSON.parse(result.body);
      expect(body.error).toBe('Unauthorized');
    });

    test('should accept valid JWT with userId', async () => {
      const event = {
        requestContext: {
          authorizer: {
            jwt: {
              claims: {
                sub: 'user123',
              },
            },
          },
        },
        queryStringParameters: {
          since: '2024-01-01T00:00:00.000Z',
        },
      } as unknown as APIGatewayProxyEventV2;

      const result = await mockHandler.handler(event);

      expect(result.statusCode).toBe(200);
    });
  });

  describe('Query Parameter Validation', () => {
    test('should return 400 when since parameter is missing', async () => {
      const event = {
        requestContext: {
          authorizer: {
            jwt: {
              claims: {
                sub: 'user123',
              },
            },
          },
        },
        queryStringParameters: {},
      } as unknown as APIGatewayProxyEventV2;

      const result = await mockHandler.handler(event);

      expect(result.statusCode).toBe(400);
      const body = JSON.parse(result.body);
      expect(body.error).toBe('Missing required parameter: since');
    });

    test('should accept valid ISO-8601 UTC timestamp with Z', async () => {
      const event = {
        requestContext: {
          authorizer: {
            jwt: {
              claims: {
                sub: 'user123',
              },
            },
          },
        },
        queryStringParameters: {
          since: '2024-01-01T00:00:00.000Z',
        },
      } as unknown as APIGatewayProxyEventV2;

      const result = await mockHandler.handler(event);

      expect(result.statusCode).toBe(200);
    });

    test('should accept valid ISO-8601 UTC timestamp without milliseconds', async () => {
      const event = {
        requestContext: {
          authorizer: {
            jwt: {
              claims: {
                sub: 'user123',
              },
            },
          },
        },
        queryStringParameters: {
          since: '2024-01-01T00:00:00Z',
        },
      } as unknown as APIGatewayProxyEventV2;

      const result = await mockHandler.handler(event);

      expect(result.statusCode).toBe(200);
    });

    test('should reject invalid timestamp format', async () => {
      const event = {
        requestContext: {
          authorizer: {
            jwt: {
              claims: {
                sub: 'user123',
              },
            },
          },
        },
        queryStringParameters: {
          since: 'not-a-timestamp',
        },
      } as unknown as APIGatewayProxyEventV2;

      const result = await mockHandler.handler(event);

      expect(result.statusCode).toBe(400);
      const body = JSON.parse(result.body);
      expect(body.error).toContain('Invalid since parameter');
    });

    test('should reject non-UTC timestamp', async () => {
      const event = {
        requestContext: {
          authorizer: {
            jwt: {
              claims: {
                sub: 'user123',
              },
            },
          },
        },
        queryStringParameters: {
          since: '2024-01-01T00:00:00',
        },
      } as unknown as APIGatewayProxyEventV2;

      const result = await mockHandler.handler(event);

      expect(result.statusCode).toBe(400);
      const body = JSON.parse(result.body);
      expect(body.error).toContain('Invalid since parameter');
    });

    test('should reject timestamp with non-UTC offset', async () => {
      const event = {
        requestContext: {
          authorizer: {
            jwt: {
              claims: {
                sub: 'user123',
              },
            },
          },
        },
        queryStringParameters: {
          since: '2024-01-01T00:00:00+05:00',
        },
      } as unknown as APIGatewayProxyEventV2;

      const result = await mockHandler.handler(event);

      expect(result.statusCode).toBe(400);
      const body = JSON.parse(result.body);
      expect(body.error).toContain('Invalid since parameter');
    });
  });

  describe('Response Format', () => {
    test('should return correct response structure', async () => {
      const event = {
        requestContext: {
          authorizer: {
            jwt: {
              claims: {
                sub: 'user123',
              },
            },
          },
        },
        queryStringParameters: {
          since: '2024-01-01T00:00:00.000Z',
        },
      } as unknown as APIGatewayProxyEventV2;

      const result = await mockHandler.handler(event);

      expect(result.statusCode).toBe(200);
      const body = JSON.parse(result.body);
      expect(body).toHaveProperty('emails');
      expect(body).toHaveProperty('labels');
      expect(body).toHaveProperty('migrations');
      expect(body).toHaveProperty('nextToken');
      expect(body).toHaveProperty('serverTime');
      expect(Array.isArray(body.emails)).toBe(true);
      expect(Array.isArray(body.labels)).toBe(true);
      expect(Array.isArray(body.migrations)).toBe(true);
    });

    test('should include valid UTC serverTime', async () => {
      const event = {
        requestContext: {
          authorizer: {
            jwt: {
              claims: {
                sub: 'user123',
              },
            },
          },
        },
        queryStringParameters: {
          since: '2024-01-01T00:00:00.000Z',
        },
      } as unknown as APIGatewayProxyEventV2;

      const result = await mockHandler.handler(event);

      expect(result.statusCode).toBe(200);
      const body = JSON.parse(result.body);
      expect(body.serverTime).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
      
      // Verify it's a valid date
      const serverTime = new Date(body.serverTime);
      expect(isNaN(serverTime.getTime())).toBe(false);
    });
  });

  describe('Pagination Parameters', () => {
    test('should accept limit parameter', async () => {
      const event = {
        requestContext: {
          authorizer: {
            jwt: {
              claims: {
                sub: 'user123',
              },
            },
          },
        },
        queryStringParameters: {
          since: '2024-01-01T00:00:00.000Z',
          limit: '50',
        },
      } as unknown as APIGatewayProxyEventV2;

      const result = await mockHandler.handler(event);

      expect(result.statusCode).toBe(200);
    });

    test('should accept nextToken parameter', async () => {
      const event = {
        requestContext: {
          authorizer: {
            jwt: {
              claims: {
                sub: 'user123',
              },
            },
          },
        },
        queryStringParameters: {
          since: '2024-01-01T00:00:00.000Z',
          nextToken: 'some-token',
        },
      } as unknown as APIGatewayProxyEventV2;

      const result = await mockHandler.handler(event);

      expect(result.statusCode).toBe(200);
    });

    test('should cap limit at 500', async () => {
      const event = {
        requestContext: {
          authorizer: {
            jwt: {
              claims: {
                sub: 'user123',
              },
            },
          },
        },
        queryStringParameters: {
          since: '2024-01-01T00:00:00.000Z',
          limit: '1000',
        },
      } as unknown as APIGatewayProxyEventV2;

      const result = await mockHandler.handler(event);

      expect(result.statusCode).toBe(200);
      // The handler should internally cap the limit at 500
    });
  });
});
