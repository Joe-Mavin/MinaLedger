import { QueryTypes } from 'sequelize';
import { sequelize } from '../../database/connection.mjs';
import { AppError } from '../../utils/errors.mjs';

export function resolveMeasurementSourceParty(measure, auth) {
  if (measure.sourcePartyId) return measure.sourcePartyId;
  if (measure.sourceRole === 'RECORDER' && auth.personPartyId) return auth.personPartyId;
  throw new AppError(400, 'INVALID_MEASUREMENT_SOURCE', 'A source party is required for this measurement role.');
}

export async function assertMeasurementSource({
  sourcePartyId,
  sourceRole,
  auth,
  occurredAt,
  productionEventId = null,
  processingEventId = null,
  sourceProductionEventId = null,
  transaction,
}) {
  const [party] = await sequelize.query(
    `SELECT 1 FROM party WHERE id=:sourcePartyId AND status='ACTIVE'`,
    { replacements: { sourcePartyId }, type: QueryTypes.SELECT, transaction },
  );
  if (!party) {
    throw new AppError(400, 'INVALID_MEASUREMENT_SOURCE', 'The measurement source party is unavailable.');
  }
  if (sourceRole === 'RECORDER' && sourcePartyId === auth.personPartyId) return;

  const [result] = await sequelize.query(
    `SELECT
       EXISTS (
         SELECT 1
         FROM production_event_participant pep
         JOIN production_event pe ON pe.event_id=pep.production_event_id
         JOIN mining_hole h ON h.id=pe.hole_id
         LEFT JOIN site_party_role sr ON sr.id=pep.site_party_role_id
         LEFT JOIN hole_party_role hr ON hr.id=pep.hole_party_role_id
         WHERE pep.party_id=:sourcePartyId
           AND (
             (CAST(:productionEventId AS uuid) IS NOT NULL AND pep.production_event_id=:productionEventId)
             OR (
               CAST(:processingEventId AS uuid) IS NOT NULL
               AND pep.production_event_id IN (
                 SELECT source_peo.production_event_id
                 FROM processing_event_input pei
                 JOIN production_event_output source_peo
                   ON source_peo.material_event_output_id=pei.source_production_output_id
                 WHERE pei.processing_event_id=:processingEventId
                   AND (CAST(:sourceProductionEventId AS uuid) IS NULL OR source_peo.production_event_id=:sourceProductionEventId)
               )
             )
           )
           AND (
             (sr.id IS NOT NULL AND sr.site_id=h.site_id AND sr.status='ACTIVE'
               AND sr.valid_from<=:occurredAt AND (sr.valid_to IS NULL OR sr.valid_to>:occurredAt))
             OR
             (hr.id IS NOT NULL AND hr.hole_id=h.id AND hr.status='ACTIVE'
               AND hr.valid_from<=:occurredAt AND (hr.valid_to IS NULL OR hr.valid_to>:occurredAt))
           )
       )
       OR EXISTS (
         SELECT 1 FROM facility_party_role fpr
         WHERE fpr.processing_facility_id=(
           SELECT pe.processing_facility_id FROM processing_event pe WHERE pe.event_id=:processingEventId
         )
           AND CAST(:processingEventId AS uuid) IS NOT NULL
           AND fpr.party_id=:sourcePartyId AND fpr.status='ACTIVE'
           AND fpr.valid_from<=:occurredAt AND (fpr.valid_to IS NULL OR fpr.valid_to>:occurredAt)
       ) AS valid`,
    {
      replacements: {
        sourcePartyId, productionEventId, processingEventId, sourceProductionEventId, occurredAt,
      },
      type: QueryTypes.SELECT,
      transaction,
    },
  );
  if (!result?.valid) {
    throw new AppError(400, 'INVALID_MEASUREMENT_SOURCE', 'The measurement source party has no effective relationship to this production or processing context.');
  }
}
