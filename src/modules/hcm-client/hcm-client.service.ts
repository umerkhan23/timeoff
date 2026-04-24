import { Injectable, Logger, HttpException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios, { AxiosInstance, AxiosError } from 'axios';

export interface HcmBalanceRecord {
  employeeExternalId: string;
  locationExternalId: string;
  totalDays: number;
  reservedDays?: number;
  usedDays?: number;
}

export interface HcmRealtimeUpdate {
  employeeExternalId: string;
  locationExternalId: string;
  totalDays: number;
  reservedDays?: number;
  usedDays?: number;
}

export interface HcmSubmitResult {
  status: 'ACCEPTED' | 'REJECTED';
  hcm_reference_id?: string;
  errorCode?: string;
  errorMessage?: string;
  remainingBalance?: number;
}

export interface HcmBatchResponse {
  balances: HcmBalanceRecord[];
  generatedAt: string;
}

@Injectable()
export class HcmClientService {
  private readonly logger = new Logger(HcmClientService.name);
  private readonly http: AxiosInstance;

  constructor(private readonly config: ConfigService) {
    this.http = axios.create({
      baseURL: this.config.get('HCM_BASE_URL', 'http://localhost:4000'),
      timeout: this.config.get('HCM_TIMEOUT_MS', 10000),
      headers: {
        'Content-Type': 'application/json',
        'X-Api-Key': this.config.get('HCM_API_KEY', 'mock-key'),
        'X-Source': 'ReadyOn',
      },
    });
  }

  /** GET single balance — used for real-time pre-submission validation */
  async getBalance(empExternalId: string, locExternalId: string): Promise<HcmBalanceRecord> {
    try {
      const { data } = await this.http.get(`/hcm/balances/${empExternalId}/${locExternalId}`);
      return data;
    } catch (err) {
      this.rethrow(err, 'getBalance');
    }
  }

  /** POST a time-off request to HCM. Returns ACCEPTED or REJECTED. */
  async submitRequest(payload: {
    employeeExternalId: string;
    locationExternalId: string;
    startDate: string;
    endDate: string;
    durationDays: number;
    referenceId: string;
  }): Promise<HcmSubmitResult> {
    try {
      const { data } = await this.http.post('/hcm/requests', payload);
      return data;
    } catch (err) {
      if (axios.isAxiosError(err) && err.response && err.response.status < 500) {
        // HCM returned a 4xx with structured error body — normalise to REJECTED
        const body = err.response.data as any;
        return {
          status: 'REJECTED',
          errorCode: body?.errorCode ?? 'HCM_ERROR',
          errorMessage: body?.message ?? err.message,
        };
      }
      // 5xx / network errors are transient — throw so the retry scheduler can handle them
      this.rethrow(err, 'submitRequest');
    }
  }

  /** DELETE — cancel a previously filed HCM request */
  async cancelRequest(hcmReferenceId: string): Promise<{ success: boolean }> {
    try {
      const { data } = await this.http.delete(`/hcm/requests/${hcmReferenceId}`);
      return data;
    } catch (err) {
      this.rethrow(err, 'cancelRequest');
    }
  }

  /** POST to trigger HCM to push all balances to our batch endpoint */
  async triggerBatchPull(employeeExternalIds?: string[]): Promise<HcmBatchResponse> {
    try {
      const { data } = await this.http.post('/hcm/batch', { employeeExternalIds: employeeExternalIds ?? [] });
      return data;
    } catch (err) {
      this.rethrow(err, 'triggerBatchPull');
    }
  }

  private rethrow(err: any, operation: string): never {
    if (axios.isAxiosError(err)) {
      const status = err.response?.status ?? 503;
      const msg = err.response?.data?.message ?? err.message;
      this.logger.error(`HCM ${operation} failed [${status}]: ${msg}`);
      throw new HttpException(`HCM ${operation} error: ${msg}`, status);
    }
    throw err;
  }
}
