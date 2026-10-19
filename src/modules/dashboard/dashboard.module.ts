import { Module } from '@nestjs/common';
import { DashboardController } from './dashboard.controller';
import { DashboardService } from './dashboard.service';

// The repositories table on the dashboard reuses GET …/repos (ReposModule);
// this module only adds the aggregates that endpoint has no room for.
@Module({
  controllers: [DashboardController],
  providers: [DashboardService],
})
export class DashboardModule {}
