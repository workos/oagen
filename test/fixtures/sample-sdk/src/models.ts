export interface ClientOptions {
  apiKey: string;
  baseUrl?: string;
}

export interface Organization {
  id: string;
  name: string;
  createdAt: string;
}

export interface ListResponse<T> {
  data: T[];
  hasMore: boolean;
}

export type StatusType = 'active' | 'inactive';

export enum Status {
  Active = 'active',
  Inactive = 'inactive',
}
