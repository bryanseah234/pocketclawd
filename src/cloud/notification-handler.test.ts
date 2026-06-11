/**
 * Tests for daily briefing notification handler.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { sendDailyBriefings, generateBriefingPrompt } from './notification-handler.js';

vi.mock('@aws-sdk/client-dynamodb', () => {
  class DynamoDBClient { send = vi.fn(); }
  class ScanCommand { constructor(public input: unknown) {} }
  return { DynamoDBClient, ScanCommand };
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

const mockRedis = {
  lpush: vi.fn().mockResolvedValue(1),
  expire: vi.fn().mockResolvedValue(1),
};

const mockInvokeModel = vi.fn().mockResolvedValue('Good morning! Here is your briefing.');

const baseConfig = {
  dynamoClient: {} as any,
  invokeModel: mockInvokeModel,
  redisClient: mockRedis as any,
  userPreferencesTable: 'nanoclaw-user-preferences',
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
    mockInvokeModel.mockResolvedValue('Good morning!');
  });

  it('returns empty array for no users', async () => {
    const { DynamoDBDocumentClient } = await import('@aws-sdk/lib-dynamodb') as any;
    DynamoDBDocumentClient.from = () => ({ send: vi.fn().mockResolvedValue({ Items: [] }) });
    const results = await sendDailyBriefings(baseConfig);
    expect(results).toEqual([]);
  });

  it('skips user with no preferences', async () => {
    const { DynamoDBDocumentClient } = await import('@aws-sdk/lib-dynamodb') as any;
    DynamoDBDocumentClient.from = () => ({
      send: vi.fn()
        .mockResolvedValueOnce({ Items: [{ userId: { S: 'user1' } }] })
        .mockResolvedValueOnce({ Item: undefined })
        .mockResolvedValueOnce({ Item: undefined }),
    });
    const results = await sendDailyBriefings(baseConfig);
    expect(results.find(r => r.userId === 'user1')?.status).toBe('skipped');
  });

  it('handles DynamoDB scan error gracefully', async () => {
    const { DynamoDBDocumentClient } = await import('@aws-sdk/lib-dynamodb') as any;
    DynamoDBDocumentClient.from = () => ({ send: vi.fn().mockRejectedValue(new Error('DynamoDB down')) });
    const results = await sendDailyBriefings(baseConfig);
    expect(results[0]?.status).toBe('error');
    expect(results[0]?.reason).toContain('DynamoDB down');
  });

  it('handles invokeModel error gracefully', async () => {
    const { DynamoDBDocumentClient } = await import('@aws-sdk/lib-dynamodb') as any;
    DynamoDBDocumentClient.from = () => ({
      send: vi.fn()
        .mockResolvedValueOnce({ Items: [{ userId: { S: 'u1' } }] })
        .mockResolvedValueOnce({ Item: { preferenceValue: 'detailed' } })
        .mockResolvedValueOnce({ Item: { preferenceValue: 'data' } }),
    });
    mockInvokeModel.mockRejectedValueOnce(new Error('LLM error'));
    const results = await sendDailyBriefings(baseConfig);
    expect(results.find(r => r.userId === 'u1')?.status).toBe('error');
  });

  it('handles Redis push error gracefully', async () => {
    const { DynamoDBDocumentClient } = await import('@aws-sdk/lib-dynamodb') as any;
    DynamoDBDocumentClient.from = () => ({
      send: vi.fn()
        .mockResolvedValueOnce({ Items: [{ userId: { S: 'u2' } }] })
        .mockResolvedValueOnce({ Item: { preferenceValue: 'high-level' } })
        .mockResolvedValueOnce({ Item: { preferenceValue: 'frontend' } }),
    });
    const badRedis = { lpush: vi.fn().mockRejectedValue(new Error('Redis down')), expire: vi.fn() };
    const results = await sendDailyBriefings({ ...baseConfig, redisClient: badRedis as any });
    expect(results.find(r => r.userId === 'u2')?.status).toBe('error');
  });

  it('sets correct TTL on Redis key (3600s)', async () => {
    const { DynamoDBDocumentClient } = await import('@aws-sdk/lib-dynamodb') as any;
    DynamoDBDocumentClient.from = () => ({
      send: vi.fn()
        .mockResolvedValueOnce({ Items: [{ userId: { S: 'u3' } }] })
        .mockResolvedValueOnce({ Item: { preferenceValue: 'detailed' } })
        .mockResolvedValueOnce({ Item: { preferenceValue: 'infrastructure' } }),
    });
    const redis = { lpush: vi.fn().mockResolvedValue(1), expire: vi.fn().mockResolvedValue(1) };
    await sendDailyBriefings({ ...baseConfig, redisClient: redis as any });
    expect(redis.expire).toHaveBeenCalledWith(expect.stringContaining('u3'), 3600);
  });
});
