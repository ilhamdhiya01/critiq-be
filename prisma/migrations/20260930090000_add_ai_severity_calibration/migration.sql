-- v1.5.1 AI severity calibration: the model's own severity and risk level
-- are kept next to the calibrated ones, and low-confidence findings that
-- are not stored are counted.
ALTER TABLE "findings" ADD COLUMN "reportedSeverity" "FindingSeverity";

ALTER TABLE "scans" ADD COLUMN "aiFindingsDropped" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN "aiReportedRiskLevel" "AiRiskLevel";
