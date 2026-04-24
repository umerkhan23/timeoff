import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ConfigModule } from '@nestjs/config';
import { ScheduleModule } from '@nestjs/schedule';
import { Employee } from '../../src/modules/employees/entities/employee.entity';
import { Location } from '../../src/modules/locations/entities/location.entity';
import { LeaveBalance } from '../../src/modules/balances/entities/leave-balance.entity';
import { TimeOffRequest } from '../../src/modules/requests/entities/time-off-request.entity';
import { BalanceAuditLog } from '../../src/modules/audit/entities/balance-audit-log.entity';
import { SyncJob } from '../../src/modules/sync/entities/sync-job.entity';
import { EmployeeModule } from '../../src/modules/employees/employee.module';
import { LocationModule } from '../../src/modules/locations/location.module';
import { AuditModule } from '../../src/modules/audit/audit.module';
import { HcmClientModule } from '../../src/modules/hcm-client/hcm-client.module';
import { BalanceModule } from '../../src/modules/balances/balance.module';
import { RequestModule } from '../../src/modules/requests/request.module';
import { SyncModule } from '../../src/modules/sync/sync.module';
import { DataSource } from 'typeorm';
import { v4 as uuidv4 } from 'uuid';

export const SEED = {
  emp: { id: uuidv4(), external_id: 'EMP001', name: 'Alice', email: 'alice@test.com' },
  emp2: { id: uuidv4(), external_id: 'EMP002', name: 'Bob', email: 'bob@test.com' },
  loc: { id: uuidv4(), external_id: 'LOC-US', name: 'New York' },
  loc2: { id: uuidv4(), external_id: 'LOC-UK', name: 'London' },
};

export async function buildTestApp(hcmBaseUrl = 'http://localhost:4000'): Promise<{
  app: INestApplication;
  module: TestingModule;
  ds: DataSource;
}> {
  // Ensure ConfigService.get('HCM_BASE_URL') resolves deterministically in tests.
  process.env.HCM_BASE_URL = hcmBaseUrl;
  process.env.HCM_API_KEY = 'test-key';
  process.env.HCM_TIMEOUT_MS = '5000';
  process.env.NODE_ENV = 'test';

  const module = await Test.createTestingModule({
    imports: [
      ConfigModule.forRoot({
        isGlobal: true,
        load: [() => ({
          HCM_BASE_URL: hcmBaseUrl,
          HCM_API_KEY: 'test-key',
          HCM_TIMEOUT_MS: 5000,
          NODE_ENV: 'test',
        })],
      }),
      ScheduleModule.forRoot(),
      TypeOrmModule.forRoot({
        type: 'sqljs',
        synchronize: true,
        logging: false,
        entities: [Employee, Location, LeaveBalance, TimeOffRequest, BalanceAuditLog, SyncJob],
      }),
      EmployeeModule, LocationModule, AuditModule,
      HcmClientModule, BalanceModule, RequestModule, SyncModule,
    ],
  }).compile();

  const app = module.createNestApplication();
  app.useGlobalPipes(new ValidationPipe({ transform: true, whitelist: true }));
  await app.init();

  const ds = module.get(DataSource);
  return { app, module, ds };
}

export async function seedDb(ds: DataSource, balanceDays = 20) {
  const empRepo = ds.getRepository(Employee);
  const locRepo = ds.getRepository(Location);
  const balRepo = ds.getRepository(LeaveBalance);

  await empRepo.save([
    empRepo.create(SEED.emp),
    empRepo.create(SEED.emp2),
  ]);
  await locRepo.save([
    locRepo.create(SEED.loc),
    locRepo.create(SEED.loc2),
  ]);
  await balRepo.save(
    balRepo.create({
      id: uuidv4(),
      employee_id: SEED.emp.id,
      location_id: SEED.loc.id,
      total_days: balanceDays,
      reserved_days: 0,
      used_days: 0,
      version: 0,
    }),
  );
}

export async function wipeDb(ds: DataSource) {
  for (const t of ['time_off_requests','leave_balances','balance_audit_log','sync_jobs','employees','locations']) {
    await ds.query(`DELETE FROM ${t}`);
  }
}
