import {
  FindingSeverity,
  FindingSource,
} from '../../../generated/prisma/enums';
import { FindingDto } from './finding.dto';

const base = {
  id: 'f_1',
  source: FindingSource.AI,
  ruleId: 'ai.error_handling',
  severity: FindingSeverity.MINOR,
  title: 'Missing error feedback',
  message: 'The form returns early without telling the user.',
  filePath: 'src/form.js',
  lineStart: 24,
  lineEnd: 31,
  snippet: null,
  suppressedReason: null,
};

describe('FindingDto meta', () => {
  it('shows the model severity when calibration changed it', () => {
    const dto = new FindingDto({
      ...base,
      reportedSeverity: FindingSeverity.MAJOR,
    });
    expect(dto.meta).toEqual({ reportedSeverity: FindingSeverity.MAJOR });
    expect(dto).not.toHaveProperty('reportedSeverity');
  });

  it('is null when nothing changed, and for static findings', () => {
    expect(
      new FindingDto({ ...base, reportedSeverity: FindingSeverity.MINOR }).meta,
    ).toBeNull();
    expect(
      new FindingDto({
        ...base,
        source: FindingSource.STATIC,
        reportedSeverity: null,
      }).meta,
    ).toBeNull();
  });
});
