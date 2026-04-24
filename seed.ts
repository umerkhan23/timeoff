import 'reflect-metadata';
import { DataSource } from 'typeorm';
import { v4 as uuidv4 } from 'uuid';
import { Employee } from './src/modules/employees/entities/employee.entity';
import { Location } from './src/modules/locations/entities/location.entity';
import { LeaveBalance } from './src/modules/balances/entities/leave-balance.entity';
import { TimeOffRequest } from './src/modules/requests/entities/time-off-request.entity';
import { BalanceAuditLog } from './src/modules/audit/entities/balance-audit-log.entity';
import { SyncJob } from './src/modules/sync/entities/sync-job.entity';

const ds = new DataSource({
  type: 'sqljs',
  synchronize: true,
  autoSave: true,
  location: process.env.DB_PATH ?? 'timeoff.db',
  logging: false,
  entities: [Employee, Location, LeaveBalance, TimeOffRequest, BalanceAuditLog, SyncJob],
});

async function seed() {
  await ds.initialize();

  const empRepo = ds.getRepository(Employee);
  const locRepo = ds.getRepository(Location);
  const balRepo = ds.getRepository(LeaveBalance);

  // Check if already seeded
  const existing = await empRepo.findOne({ where: { external_id: 'EMP001' } });
  if (existing) {
    const loc = await locRepo.findOne({ where: { external_id: 'LOC-US' } });
    const bal = await balRepo.findOne({ where: { employee_id: existing.id, location_id: loc?.id } });
    console.log('\n=== Already seeded — use these IDs ===');
    console.log(`employeeId : ${existing.id}`);
    console.log(`locationId : ${loc?.id}`);
    console.log(`balance    : ${bal?.total_days} days total, ${bal?.reserved_days} reserved, ${bal?.used_days} used`);
    await ds.destroy();
    return;
  }

  const emp = empRepo.create({ id: uuidv4(), external_id: 'EMP001', name: 'Alice Smith', email: 'alice@wizdaa.com' });
  const emp2 = empRepo.create({ id: uuidv4(), external_id: 'EMP002', name: 'Bob Jones', email: 'bob@wizdaa.com' });
  await empRepo.save([emp, emp2]);

  const loc = locRepo.create({ id: uuidv4(), external_id: 'LOC-US', name: 'New York' });
  const loc2 = locRepo.create({ id: uuidv4(), external_id: 'LOC-UK', name: 'London' });
  await locRepo.save([loc, loc2]);

  await balRepo.save([
    balRepo.create({ id: uuidv4(), employee_id: emp.id, location_id: loc.id, total_days: 20, reserved_days: 0, used_days: 0, version: 0 }),
    balRepo.create({ id: uuidv4(), employee_id: emp2.id, location_id: loc.id, total_days: 15, reserved_days: 0, used_days: 0, version: 0 }),
    balRepo.create({ id: uuidv4(), employee_id: emp.id, location_id: loc2.id, total_days: 10, reserved_days: 0, used_days: 0, version: 0 }),
  ]);

  console.log('\n=== Seed complete — use these IDs ===');
  console.log(`employeeId (Alice) : ${emp.id}`);
  console.log(`employeeId (Bob)   : ${emp2.id}`);
  console.log(`locationId (NY)    : ${loc.id}`);
  console.log(`locationId (London): ${loc2.id}`);
  console.log('\nAlice has 20 days in New York, 10 days in London');
  console.log('Bob has 15 days in New York');

  await ds.destroy();
}

seed().catch(console.error);
