import { describe, expect, it } from 'vitest';
import { errorResponse, successResponse } from './api-response.js';

describe('successResponse', () => {
  it('wraps the payload in the success envelope', () => {
    const data = { id: 1, name: 'Springfield High' };

    expect(successResponse('Created', data)).toEqual({
      success: true,
      message: 'Created',
      data,
    });
  });

  it('supports primitive and null payloads', () => {
    expect(successResponse('ok', null)).toEqual({
      success: true,
      message: 'ok',
      data: null,
    });
  });
});

describe('errorResponse', () => {
  it('wraps the status code in the error envelope', () => {
    expect(errorResponse(404, 'Not found')).toEqual({
      success: false,
      message: 'Not found',
      error: { statusCode: 404 },
    });
  });
});
