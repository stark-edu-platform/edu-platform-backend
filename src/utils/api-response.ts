export type ApiSuccessResponse<T> = {
  success: true;
  message: string;
  data: T;
};

export type ApiErrorResponse = {
  success: false;
  message: string;
  error: {
    statusCode: number;
  };
};

export function successResponse<T>(
  message: string,
  data: T,
): ApiSuccessResponse<T> {
  return {
    success: true,
    message,
    data,
  };
}

export function errorResponse(
  statusCode: number,
  message: string,
): ApiErrorResponse {
  return {
    success: false,
    message,
    error: {
      statusCode,
    },
  };
}
