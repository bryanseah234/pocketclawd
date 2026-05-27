/**
 * Tests for daily briefing notification handler.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { sendDailyBriefings, generateBriefingPrompt } from './notification-handler.js';

vi.mock('@aws-sdk/client-dynamodb', () => {
  const mockSend = vi.fn();
  class DynamoDBClient { send = mockSend; }
  class ScanCommand { constructor(public input: unknown) {} }
  return { DynamoDBClient, ScanCommand, mockSend };
});
vi.mock('@aws-sdk/lib-dynamodb', () => {
  const mockSend = vi.fn();
  class DynamoDBDocumentClient {
    static from() { return new DynamoDBDocumentClient(); }
    send = mockSend;
  }
  class GetCommand { constructor(public input: unknown) {} }
  return { DynamoDBDocumentClient, GetCommand, mockDocSend: mockSend };
});
vi.mock('@aws-sdk/client-bedrock-runtime', () => {
  const mockSend = vi.fn();
  class BedrockRuntimeClient { send = mockSend; }
  class InvokeModelCommand { constructor(public input: unknown) {} }
  return { BedrockRuntimeClient, InvokeModelCommand, mockBedrockSend: mockSend };
});

const mockRedis = {
  lpush: vi.fn().mockResolvedValue(1),
  expire: vi.fn().mockResolvedValue(1),
};

const baseConfig = {
  dynamoClient: {} as any,
  bedrockClient: {} as any,
  redisClient: mockRedis as any,
  userPreferencesTable: 'nanoclaw-user-preferences',
  modelId: 'global.anthropic.claude-sonnet-4-6',
};

describe('generateBriefingPrompt', () => {
  it('includes technical_depth in prompt', () => {
    const p = generateBriefingPrompt({ technical_depth: 'detailed', primary_domain: 'data' });
    expect(p).toContain('detailed');
  });

  it('includes primary_domain in prompt', () => {
    const p = generateBriefingPrompt({ technical_depth: 'high-level', primary_domain: 'frontend' });
    expect(p).toContain('frontend');
  });

  it('handles undefined prefs with defaults', () => {
    const p = generateBriefingPrompt({});
    expect(p).toContain('high-level');
    expect(p).toContain('general');
  });
});

describe('sendDailyBriefings', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRedis.lpush.mockResolvedValue(1);
    mockRedis.expire.mockResolvedValue(1);
  });

  it('returns empty array for no users', async () => {
    const { DynamoDBDocumentClient } = await import('@aws-sdk/lib-dynamodb') as any;
    const inst = DynamoDBDocumentClient.from();
    inst.send.mockResolvedValue({ Items: [] });
    const results = await sendDailyBriefings({ ...baseConfig, dynamoClient: { send: vi.fn().mockResolvedValue({ Items: [] }) } as any });
    expect(results).toEqual([]);
  });

  it('skips user with no preferences', async () => {
    const dynamo = {
      send: vi.fn()
        .mockResolvedValueOnce({ Items: [{ userId: { S: 'user1' } }] }) // scan
        .mockResolvedValueOnce({ Item: undefined }) // depth
        .mockResolvedValueOnce({ Item: undefined }), // domain
    };
    const { DynamoDBDocumentClient } = await import('@aws-sdk/lib-dynamodb') as any;
    DynamoDBDocumentClient.from = () => dynamo;
    const results = await sendDailyBriefings({ ...baseConfig });
    expect(results.find(r => r.userId === 'user1')?.status).toBe('skipped');
  });

  it('handles DynamoDB scan error gracefully', async () => {
    const dynamo = { send: vi.fn().mockRejectedValue(new Error('DynamoDB down')) };
    const { DynamoDBDocumentClient } = await import('@aws-sdk/lib-dynamodb') as any;
    DynamoDBDocumentClient.from = () => dynamo;
    const results = await sendDailyBriefings({ ...baseConfig });
    expect(results[0]?.status).toBe('error');
    expect(results[0]?.reason).toContain('DynamoDB down');
  });

  it('handles Bedrock error gracefully', async () => {
    const dynamo = {
      send: vi.fn()
        .mockResolvedValueOnce({ Items: [{ userId: { S: 'u1' } }] })
        .mockResolvedValueOnce({ Item: { preferenceValue: 'detailed' } })
        .mockResolvedValueOnce({ Item: { preferenceValue: 'data' } }),
    };
    const bedrock = { send: vi.fn().mockRejectedValue(new Error('Bedrock error')) };
    const { DynamoDBDocumentClient } = await import('@aws-sdk/lib-dynamodb') as any;
    DynamoDBDocumentClient.from = () => dynamo;
    const results = await sendDailyBriefings({ ...baseConfig, bedrockClient: bedrock as any });
    expect(results.find(r => r.userId === 'u1')?.status).toBe('error');
  });

  it('handles Redis push error gracefully', async () => {
    const dynamo = {
      send: vi.fn()
        .mockResolvedValueOnce({ Items: [{ userId: { S: 'u2' } }] })
        .mockResolvedValueOnce({ Item: { preferenceValue: 'high-level' } })
        .mockResolvedValueOnce({ Item: { preferenceValue: 'frontend' } }),
    };
    const bedrock = {
      send: vi.fn().mockResolvedValue({
        body: Buffer.from(JSON.stringify({ content: [{ text: 'Good morning!' }] })),
      }),
    };
    const redis = { lpush: vi.fn().mockRejectedValue(new Error('Redis down')), expire: vi.fn() };
    const { DynamoDBDocumentClient } = await import('@aws-sdk/lib-dynamodb') as any;
    DynamoDBDocumentClient.from = () => dynamo;
    const results = await sendDailyBriefings({ ...baseConfig, bedrockClient: bedrock as any, redisClient: redis as any });
    expect(results.find(r => r.userId === 'u2')?.status).toBe('error');
  });

  it('sets correct TTL on Redis key (3600s)', async () => {
    const dynamo = {
      send: vi.fn()
        .mockResolvedValueOnce({ Items: [{ userId: { S: 'u3' } }] })
        .mockResolvedValueOnce({ Item: { preferenceValue: 'detailed' } })
        .mockResolvedValueOnce({ Item: { preferenceValue: 'infrastructure' } }),
    };
    const bedrock = {
      send: vi.fn().mockResolvedValue({
        body: Buffer.from(JSON.stringify({ content: [{ text: 'Morning!' }] })),
      }),
    };
    const redis = { lpush: vi.fn().mockResolvedValue(1), expire: vi.fn().mockResolvedValue(1) };
    const { DynamoDBDocumentClient } = await import('@aws-sdk/lib-dynamodb') as any;
    DynamoDBDocumentClient.from = () => dynamo;
    await sendDailyBriefings({ ...baseConfig, bedrockClient: bedrock as any, redisClient: redis as any });
    expect(redis.expire).toHaveBeenCalledWith(expect.stringContaining('u3'), 3600);
  });
});
