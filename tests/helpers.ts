import type { ApiFailure, ApiSuccess } from '@shop/shared';

export const readError = async (res: Response) => ((await res.json()) as ApiFailure).error;
export const readData = async <T>(res: Response) => ((await res.json()) as ApiSuccess<T>).data;
