-- Expand Game Result diagnostics without changing existing completed rows.
ALTER TABLE `GameResult`
    ADD COLUMN `abortReason` VARCHAR(200) NULL;
