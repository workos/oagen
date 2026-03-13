import type { ClientOptions, Organization, ListResponse } from './models.js';

export class SampleClient {
  readonly baseUrl: string;
  private apiKey: string;

  constructor(options: ClientOptions) {
    this.baseUrl = options.baseUrl ?? 'https://api.example.com';
    this.apiKey = options.apiKey;
  }

  async getOrganization(id: string): Promise<Organization> {
    return { id, name: '', createdAt: '' };
  }

  async listOrganizations(limit?: number): Promise<ListResponse<Organization>> {
    return { data: [], hasMore: false };
  }

  async deleteOrganization(id: string): Promise<void> {
    // no-op
  }
}

export class ExtendedClient extends SampleClient {
  async createOrganization(name: string): Promise<Organization> {
    return { id: '', name, createdAt: '' };
  }
}
