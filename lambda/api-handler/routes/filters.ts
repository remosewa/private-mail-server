/**
 * Filters API routes
 * 
 * Manages email filters with optimistic locking.
 * Each filter is stored as a separate row with sort key pattern: filter#<filterId>
 */

import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, PutCommand, DeleteCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda';

type ApiEvent = APIGatewayProxyEventV2;
type ApiResult = APIGatewayProxyResultV2;

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const TABLE_NAME = process.env.EMAILS_TABLE_NAME!;

function getUserId(event: ApiEvent): string | undefined {
  // @ts-expect-error - authorizer is added by API Gateway JWT authorizer at runtime
  return event.requestContext.authorizer?.jwt?.claims?.['sub'] as string | undefined;
}

interface FilterCondition {
  field: 'subject' | 'body' | 'from' | 'to' | 'cc' | 'date' | 'hasAttachment' | 'label';
  operator: 'equals' | 'startsWith' | 'endsWith' | 'contains' | 'before' | 'after' | 'between' | 'hasLabel' | 'notHasLabel';
  value: string | string[];
}

interface FilterGroup {
  operator: 'AND' | 'OR';
  conditions: FilterCondition[];
}

interface EmailFilter {
  operator: 'AND' | 'OR';
  groups: FilterGroup[];
}

interface FilterActions {
  mode: 'once' | 'always';
  folder?: string;
  labels?: {
    mode: 'add' | 'remove' | 'set';
    labelIds: string[];
  };
  markAsRead?: boolean; // true = mark as read, false = mark as unread, undefined = no change
}

interface SavedFilter {
  userId: string;
  filterId: string;
  name: string;
  filter: EmailFilter;
  actions?: FilterActions;
  enabled: boolean; // Whether "Run Always" is enabled
  version: number;
  createdAt: string;
  lastUpdatedAt: string;
}

/**
 * GET /filters
 * List all filters for the authenticated user
 */
export async function listFilters(event: ApiEvent): Promise<ApiResult> {
  const userId = getUserId(event);
  if (!userId) {
    return { statusCode: 401, body: JSON.stringify({ error: 'Unauthorized' }) };
  }

  try {
    const result = await ddb.send(new QueryCommand({
      TableName: TABLE_NAME,
      KeyConditionExpression: 'PK = :pk AND begins_with(SK, :prefix)',
      ExpressionAttributeValues: {
        ':pk': `USER#${userId}`,
        ':prefix': 'FILTER#',
      },
    }));

    const filters = (result.Items || []).map(item => ({
      filterId: item.SK.replace('FILTER#', ''),
      name: item.name,
      filter: item.filter,
      actions: item.actions,
      enabled: item.enabled || false,
      version: item.version,
      createdAt: item.createdAt,
      lastUpdatedAt: item.lastUpdatedAt,
    }));

    return {
      statusCode: 200,
      body: JSON.stringify({ filters }),
    };
  } catch (error) {
    console.error('Failed to list filters:', error);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: 'Failed to list filters' }),
    };
  }
}

/**
 * GET /filters/:filterId
 * Get a specific filter
 */
export async function getFilter(event: ApiEvent): Promise<ApiResult> {
  const userId = getUserId(event);
  if (!userId) {
    return { statusCode: 401, body: JSON.stringify({ error: 'Unauthorized' }) };
  }

  const filterId = event.pathParameters?.filterId;
  if (!filterId) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Missing filterId' }) };
  }

  try {
    const result = await ddb.send(new GetCommand({
      TableName: TABLE_NAME,
      Key: {
        PK: `USER#${userId}`,
        SK: `FILTER#${filterId}`,
      },
    }));

    if (!result.Item) {
      return { statusCode: 404, body: JSON.stringify({ error: 'Filter not found' }) };
    }

    return {
      statusCode: 200,
      body: JSON.stringify({
        filterId: result.Item.SK.replace('FILTER#', ''),
        name: result.Item.name,
        filter: result.Item.filter,
        actions: result.Item.actions,
        enabled: result.Item.enabled || false,
        version: result.Item.version,
        createdAt: result.Item.createdAt,
        lastUpdatedAt: result.Item.lastUpdatedAt,
      }),
    };
  } catch (error) {
    console.error('Failed to get filter:', error);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: 'Failed to get filter' }),
    };
  }
}

/**
 * PUT /filters/:filterId
 * Create or update a filter with optimistic locking
 */
export async function putFilter(event: ApiEvent): Promise<ApiResult> {
  const userId = getUserId(event);
  if (!userId) {
    return { statusCode: 401, body: JSON.stringify({ error: 'Unauthorized' }) };
  }

  const filterId = event.pathParameters?.filterId;
  if (!filterId) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Missing filterId' }) };
  }

  let body: {
    name: string;
    filter: EmailFilter;
    actions?: FilterActions;
    enabled?: boolean;
    version?: number;
  };

  try {
    body = JSON.parse(event.body || '{}');
  } catch {
    return { statusCode: 400, body: JSON.stringify({ error: 'Invalid JSON' }) };
  }

  if (!body.name || !body.filter) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Missing required fields: name, filter' }) };
  }

  const now = new Date().toISOString();
  const pk = `USER#${userId}`;
  const sk = `FILTER#${filterId}`;

  try {
    // Check if filter exists
    const existing = await ddb.send(new GetCommand({
      TableName: TABLE_NAME,
      Key: { PK: pk, SK: sk },
    }));

    if (existing.Item) {
      // Update existing filter with optimistic locking
      if (body.version === undefined) {
        return {
          statusCode: 400,
          body: JSON.stringify({ error: 'Version required for updates' }),
        };
      }

      const currentVersion = existing.Item.version || 1;
      if (body.version !== currentVersion) {
        return {
          statusCode: 409,
          body: JSON.stringify({
            error: 'CONFLICT',
            message: 'Filter was modified by another client',
            currentVersion,
          }),
        };
      }

      const newVersion = currentVersion + 1;

      await ddb.send(new PutCommand({
        TableName: TABLE_NAME,
        Item: {
          PK: pk,
          SK: sk,
          name: body.name,
          filter: body.filter,
          actions: body.actions || null,
          enabled: body.enabled || false,
          version: newVersion,
          createdAt: existing.Item.createdAt,
          lastUpdatedAt: now,
        },
        ConditionExpression: '#version = :clientVersion',
        ExpressionAttributeNames: {
          '#version': 'version',
        },
        ExpressionAttributeValues: {
          ':clientVersion': currentVersion,
        },
      }));

      return {
        statusCode: 200,
        body: JSON.stringify({
          filterId,
          version: newVersion,
          lastUpdatedAt: now,
        }),
      };
    } else {
      // Create new filter
      await ddb.send(new PutCommand({
        TableName: TABLE_NAME,
        Item: {
          PK: pk,
          SK: sk,
          name: body.name,
          filter: body.filter,
          actions: body.actions || null,
          enabled: body.enabled || false,
          version: 1,
          createdAt: now,
          lastUpdatedAt: now,
        },
        ConditionExpression: 'attribute_not_exists(SK)',
      }));

      return {
        statusCode: 201,
        body: JSON.stringify({
          filterId,
          version: 1,
          lastUpdatedAt: now,
        }),
      };
    }
  } catch (error: any) {
    if (error.name === 'ConditionalCheckFailedException') {
      // Concurrent modification detected
      const current = await ddb.send(new GetCommand({
        TableName: TABLE_NAME,
        Key: { PK: pk, SK: sk },
      }));

      return {
        statusCode: 409,
        body: JSON.stringify({
          error: 'CONFLICT',
          message: 'Filter was modified by another client',
          currentVersion: current.Item?.version || 1,
        }),
      };
    }

    console.error('Failed to save filter:', error);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: 'Failed to save filter' }),
    };
  }
}

/**
 * DELETE /filters/:filterId
 * Delete a filter
 */
export async function deleteFilter(event: ApiEvent): Promise<ApiResult> {
  const userId = getUserId(event);
  if (!userId) {
    return { statusCode: 401, body: JSON.stringify({ error: 'Unauthorized' }) };
  }

  const filterId = event.pathParameters?.filterId;
  if (!filterId) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Missing filterId' }) };
  }

  try {
    await ddb.send(new DeleteCommand({
      TableName: TABLE_NAME,
      Key: {
        PK: `USER#${userId}`,
        SK: `FILTER#${filterId}`,
      },
    }));

    return {
      statusCode: 204,
      body: '',
    };
  } catch (error) {
    console.error('Failed to delete filter:', error);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: 'Failed to delete filter' }),
    };
  }
}
