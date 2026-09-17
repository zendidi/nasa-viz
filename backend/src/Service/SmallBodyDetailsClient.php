<?php

namespace App\Service;

use Symfony\Component\DependencyInjection\Attribute\Autowire;
use Symfony\Component\HttpClient\Exception\TransportException;
use Symfony\Contracts\HttpClient\Exception\ExceptionInterface;
use Symfony\Contracts\HttpClient\HttpClientInterface;
use Symfony\Contracts\HttpClient\ResponseInterface;

/**
 * Per-object sheet of a small body, from three keyless services queried
 * concurrently:
 * - JPL SBDB — always tried first: orbit class, PHA, MOID, orbital elements,
 *   and physical parameters when known. Covers freshly discovered objects;
 * - IMCCE SsODNet ssoCard — bonus: aggregated taxonomy, measured diameter,
 *   albedo, spins, mass/density. Weekly snapshot, so recent objects 404, and
 *   small NEOs usually have none of those fields (checked 2026-09-17);
 * - JPL Sentry — impact risk, when the object is monitored.
 *
 * Citation asked by IMCCE: "LTE's SsODNet VO service".
 */
final class SmallBodyDetailsClient
{
    public function __construct(
        private readonly HttpClientInterface $httpClient,
        #[Autowire(env: 'JPL_SSD_API_BASE_URL')]
        private readonly string $jplBaseUrl,
        #[Autowire(env: 'SSODNET_BASE_URL')]
        private readonly string $ssodnetBaseUrl,
    ) {
    }

    /**
     * A null entry means neither SBDB nor ssoCard knows the object. Each
     * non-null entry lists per-source status ("ok", "not_found",
     * "unavailable") so callers can avoid caching an incomplete sheet.
     *
     * @param list<string> $designations
     *
     * @return array<string, array<string, mixed>|null>
     *
     * @throws ExceptionInterface when both SBDB and ssoCard are unreachable for an object
     */
    public function getDetails(array $designations): array
    {
        $responses = [];
        foreach ($designations as $designation) {
            $responses[$designation] = [
                'sbdb' => $this->httpClient->request('GET', $this->jplBaseUrl.'/sbdb.api', ['query' => ['sstr' => $designation, 'phys-par' => '1', 'full-prec' => '1']]),
                'ssocard' => $this->httpClient->request('GET', $this->ssodnetBaseUrl.'/ssocard.php', ['query' => ['q' => str_replace(' ', '_', $designation)]]),
                'sentry' => $this->httpClient->request('GET', $this->jplBaseUrl.'/sentry.api', ['query' => ['des' => $designation]]),
            ];
        }

        $result = [];
        $unreachable = null;
        foreach ($responses as $designation => $pending) {
            [$sbdbStatus, $sbdb] = $this->collect($pending['sbdb'], static fn (int $code, array $data) => match (true) {
                $code === 200 && isset($data['object']) => 'ok',
                // Unknown → 200 with a message; ambiguous name → 300 with a list.
                $code === 200, $code === 300, $code === 404 => 'not_found',
                default => 'unavailable',
            });
            [$ssocardStatus, $ssocard] = $this->collect($pending['ssocard'], static fn (int $code, array $data) => match (true) {
                $code === 200 && isset($data['parameters']) => 'ok',
                $code === 404, $code === 200 => 'not_found',
                default => 'unavailable',
            });
            [$sentryStatus, $sentry] = $this->collect($pending['sentry'], static fn (int $code, array $data) => match (true) {
                $code === 200 && isset($data['summary']) => 'ok',
                // Never monitored, or "specified object removed" once ruled out.
                $code === 200 && isset($data['error']) => 'not_found',
                default => 'unavailable',
            });

            if ($sbdbStatus === 'unavailable' && $ssocardStatus === 'unavailable') {
                // Thrown after the loop, once every response was read (see HttpResponses::settle).
                $unreachable ??= $designation;
                continue;
            }
            $result[$designation] = $sbdbStatus !== 'ok' && $ssocardStatus !== 'ok'
                ? null
                : self::normalize(
                    $designation,
                    $sbdbStatus === 'ok' ? $sbdb : null,
                    $ssocardStatus === 'ok' ? $ssocard : null,
                    $sentryStatus === 'ok' ? $sentry : null,
                    ['sbdb' => $sbdbStatus, 'ssocard' => $ssocardStatus, 'sentry' => $sentryStatus],
                );
        }
        if ($unreachable !== null) {
            throw new TransportException(sprintf('neither JPL SBDB nor IMCCE ssoCard answered for "%s"', $unreachable));
        }

        return $result;
    }

    /**
     * Status of one response via $classify(httpCode, decodedBody); transport
     * failures and undecodable bodies count as "unavailable".
     *
     * @return array{string, array<string, mixed>}
     */
    private function collect(ResponseInterface $response, \Closure $classify): array
    {
        try {
            $code = $response->getStatusCode();
            $data = json_decode($response->getContent(false), true);
        } catch (ExceptionInterface) {
            return ['unavailable', []];
        }
        if (!is_array($data)) {
            return [$code >= 500 ? 'unavailable' : 'not_found', []];
        }

        return [$classify($code, $data), $data];
    }

    /** SMASS/Tholen class → broad complex used for colouring (S, C, X, V, or the class's own letter). */
    public static function taxonomyComplex(string $class): string
    {
        $class = trim($class);
        $base = rtrim($class, ':');

        return match (true) {
            (bool) preg_match('/^(S|Q|K|L|A|R)/', $base) => 'S',
            (bool) preg_match('/^(C|B|F|G)/', $base) => 'C',
            (bool) preg_match('/^(X|M|E|P)/', $base) => 'X',
            str_starts_with($base, 'V') => 'V',
            default => strtoupper(substr($base, 0, 1)),
        };
    }

    private static function normalize(string $designation, ?array $sbdb, ?array $ssocard, ?array $sentry, array $sources): array
    {
        $physical = [];
        foreach ($sbdb['phys_par'] ?? [] as $parameter) {
            $physical[$parameter['name']] = $parameter['value'];
        }
        $ssoPhysical = $ssocard['parameters']['physical'] ?? [];
        $ssoDynamical = $ssocard['parameters']['dynamical'] ?? [];
        $value = static fn (mixed $node) => is_array($node) && isset($node['value']) ? (float) $node['value'] : null;
        $float = static fn (mixed $raw) => is_numeric($raw) ? (float) $raw : null;

        $taxonomy = null;
        if (isset($ssoPhysical['taxonomy']['class'])) {
            $taxonomy = [
                'class' => $ssoPhysical['taxonomy']['class'],
                'complex' => $ssoPhysical['taxonomy']['complex'] ?? self::taxonomyComplex($ssoPhysical['taxonomy']['class']),
                'source' => 'ssocard',
            ];
        } elseif (isset($physical['spec_B']) || isset($physical['spec_T'])) {
            $class = $physical['spec_B'] ?? $physical['spec_T'];
            $taxonomy = ['class' => $class, 'complex' => self::taxonomyComplex($class), 'source' => isset($physical['spec_B']) ? 'sbdb_smassii' : 'sbdb_tholen'];
        }

        $diameter = null;
        if (($d = $value($ssoPhysical['diameter'] ?? null)) !== null) {
            $diameter = ['value' => $d, 'source' => 'ssocard'];
        } elseif (($d = $float($physical['diameter'] ?? null)) !== null) {
            $diameter = ['value' => $d, 'source' => 'sbdb'];
        }
        $albedo = null;
        if (($a = $value($ssoPhysical['albedo'] ?? null)) !== null) {
            $albedo = ['value' => $a, 'source' => 'ssocard'];
        } elseif (($a = $float($physical['albedo'] ?? null)) !== null) {
            $albedo = ['value' => $a, 'source' => 'sbdb'];
        }

        $orbitClass = null;
        if (isset($sbdb['object']['orbit_class'])) {
            $orbitClass = ['code' => $sbdb['object']['orbit_class']['code'], 'name' => $sbdb['object']['orbit_class']['name']];
        } elseif (isset($ssocard['class'])) {
            $orbitClass = ['code' => null, 'name' => $ssocard['class']];
        }

        return [
            'designation' => $designation,
            'fullname' => $sbdb['object']['fullname'] ?? $ssocard['name'] ?? $designation,
            'orbit_class' => $orbitClass,
            'is_pha' => isset($sbdb['object']['pha']) ? (bool) $sbdb['object']['pha'] : (isset($ssocard['class']) ? str_contains($ssocard['class'], 'PHA') : null),
            'absolute_magnitude_h' => $float($physical['H'] ?? null) ?? $value($ssoPhysical['absolute_magnitude']['H'] ?? null),
            'diameter_km' => $diameter,
            'albedo' => $albedo,
            'taxonomy' => $taxonomy,
            'rotation_period_h' => $value($ssoPhysical['spins'][0]['period'] ?? null) ?? $float($physical['rot_per'] ?? null),
            'density_kg_m3' => $value($ssoPhysical['density'] ?? null),
            'mass_kg' => $value($ssoPhysical['mass'] ?? null),
            'moid_earth_au' => $float($sbdb['orbit']['moid'] ?? null) ?? $value($ssoDynamical['moid']['Earth'] ?? null),
            'orbit' => $sbdb !== null ? self::sbdbOrbit($sbdb) : self::ssocardOrbit($ssoDynamical['orbital_elements'] ?? null),
            'impact_risk' => $sentry === null ? null : self::impactRisk($sentry),
            'sources' => $sources,
            'links' => [
                'jpl' => 'https://ssd.jpl.nasa.gov/tools/sbdb_lookup.html#/?sstr='.rawurlencode($designation),
                'ssocard' => $ssocard === null ? null : 'https://ssp.imcce.fr/forms/ssocard/'.rawurlencode($ssocard['id'] ?? str_replace(' ', '_', $designation)),
            ],
        ];
    }

    /** Heliocentric ecliptic J2000 elements. */
    private static function sbdbOrbit(array $sbdb): ?array
    {
        $elements = [];
        foreach ($sbdb['orbit']['elements'] ?? [] as $element) {
            $elements[$element['name']] = is_numeric($element['value']) ? (float) $element['value'] : null;
        }
        if (!isset($elements['a'], $elements['e'], $elements['i'], $elements['om'], $elements['w'], $elements['ma'])) {
            return null;
        }

        return [
            'epoch_jd' => (float) $sbdb['orbit']['epoch'],
            'a_au' => $elements['a'],
            'e' => $elements['e'],
            'i_deg' => $elements['i'],
            'node_deg' => $elements['om'],
            'peri_deg' => $elements['w'],
            'mean_anomaly_deg' => $elements['ma'],
            'period_days' => $elements['per'] ?? null,
            'q_au' => $elements['q'] ?? null,
            'ad_au' => $elements['ad'] ?? null,
        ];
    }

    private static function ssocardOrbit(?array $elements): ?array
    {
        $value = static fn (string $key) => isset($elements[$key]) ? (float) (is_array($elements[$key]) ? $elements[$key]['value'] : $elements[$key]) : null;
        if ($elements === null || $value('semi_major_axis') === null || $value('mean_anomaly') === null) {
            return null;
        }

        return [
            'epoch_jd' => $value('ref_epoch'),
            'a_au' => $value('semi_major_axis'),
            'e' => $value('eccentricity'),
            'i_deg' => $value('inclination'),
            'node_deg' => $value('node_longitude'),
            'peri_deg' => $value('periapsis_argument'),
            'mean_anomaly_deg' => $value('mean_anomaly'),
            'period_days' => $value('orbital_period'),
            'q_au' => $value('periapsis_distance'),
            'ad_au' => $value('apoapsis_distance'),
        ];
    }

    private static function impactRisk(array $sentry): array
    {
        $summary = $sentry['summary'];
        $years = array_map(static fn (array $impact) => (int) substr($impact['date'], 0, 4), $sentry['data'] ?? []);

        return [
            'probability' => (float) $summary['ip'],
            'palermo_cum' => (float) $summary['ps_cum'],
            'palermo_max' => (float) $summary['ps_max'],
            'torino_max' => (int) $summary['ts_max'],
            'n_impacts' => (int) ($summary['n_imp'] ?? count($years)),
            'range' => $years === [] ? null : min($years).'-'.max($years),
        ];
    }
}
