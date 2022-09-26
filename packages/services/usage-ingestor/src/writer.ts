import type { ClickHouseClient } from '@clickhouse/client';
import type { FastifyLoggerInstance } from '@hive/service-common';
import { Readable } from 'node:stream';
import { registryFields, operationsFields } from './serializer';
import type { Fallback } from './fallback';
import { writeTime } from './metrics';

export interface ClickHouseConfig {
  protocol: string;
  host: string;
  port: number;
  username: string;
  password: string;
  wait_end_of_query: 0 | 1;
  wait_for_async_insert: 0 | 1;
}

export type Writer = ReturnType<typeof createWriter>;

export function createWriter({
  clickhouse,
  clickhouseCloud,
  logger,
  fallback,
}: {
  clickhouse: ClickHouseClient;
  clickhouseCloud: ClickHouseClient | null;
  logger: FastifyLoggerInstance;
  fallback: Fallback | null;
}) {
  return {
    async writeOperations(operations: Buffer[]) {
      operations.unshift(operationsFields, Buffer.from('\n'));

      const table = 'operations';
      const buff = Buffer.concat(operations);
      const stopTimer = writeTime.startTimer({ table });
      await Promise.all([
        clickhouse
          .insert({
            table,
            values: Readable.from(buff, {
              objectMode: false,
            }),
            format: 'CSVWithNames',
          })
          .finally(() => stopTimer()),
        clickhouseCloud
          ? clickhouseCloud
              .insert({
                table,
                values: Readable.from(buff, {
                  objectMode: false,
                }),
                format: 'CSVWithNames',
              })
              .catch(error => {
                logger.error('Failed to write %s to ClickHouse Cloud: %s', table, error);
                // Ignore errors from clickhouse cloud
                return Promise.resolve();
              })
          : Promise.resolve(),
      ]).catch(async error => {
        if (fallback) {
          return fallback.write(buff, table);
        }

        throw error;
      });
    },
    async writeRegistry(records: Buffer[]) {
      records.unshift(registryFields, Buffer.from('\n'));
      const table = 'operation_collection';
      const buff = Buffer.concat(records);
      const stopTimer = writeTime.startTimer({
        table,
      });
      await Promise.all([
        clickhouse
          .insert({
            table,
            values: Readable.from(buff, {
              objectMode: false,
            }),
            format: 'CSVWithNames',
          })
          .finally(() => stopTimer()),
        clickhouseCloud
          ? clickhouseCloud
              .insert({
                table,
                values: Readable.from(buff, {
                  objectMode: false,
                }),
                format: 'CSVWithNames',
              })
              .catch(error => {
                logger.error('Failed to write %s to ClickHouse Cloud: %s', table, error);
                // Ignore errors from clickhouse cloud
                return Promise.resolve();
              })
          : Promise.resolve(),
      ]).catch(async error => {
        if (fallback) {
          return fallback.write(buff, table);
        }

        throw error;
      });
    },
  };
}
