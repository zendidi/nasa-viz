<?php

namespace App\Service;

use Symfony\Component\DependencyInjection\Attribute\Autowire;
use Symfony\Component\HttpClient\Exception\TransportException;
use Symfony\Contracts\HttpClient\Exception\ExceptionInterface;
use Symfony\Contracts\HttpClient\HttpClientInterface;
use Symfony\Contracts\HttpClient\ResponseInterface;

/**
 * Per-object sheet of a small body, from four keyless services queried
 * concurrently:
 * - JPL SBDB — always tried first: orbit class, PHA, MOID, orbital elements,
 *   and physical parameters when known. Covers freshly discovered objects;
 * - IMCCE SsODNet ssoCard — bonus: aggregated taxonomy, measured diameter,
 *   albedo, spins, mass/density. Weekly snapshot, so recent objects 404, and
 *   small NEOs usually have none of those fields (checked 2026-09-17);
 * - ESA NEOCC — its own Keplerian elements, independently fitted from the
 *   same observations as SBDB. Bonus, like ssoCard: a third orbit to compare
 *   against, never a data dependency (see getDetails()'s unreachable check);
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
        private readonly EsaNeoccClient $esaClient,
    ) {
    }

    /**
     * A null entry means neither SBDB nor ssoCard knows the object. Each
     * non-null entry lists per-source status ("ok", "not_found",
     * "unavailable") so callers can avoid caching an incomplete sheet — ESA's
     * status is included there too, but callers should NOT treat ESA like
     * the other three: see SpaceDataController::neoDetails(), which excludes
     * it from the "don't cache an incomplete sheet" check for the same
     * reason it never enters the exception below.
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
                // Sent immediately, like the other three, so the four requests
                // of an object race together — requestOrbit() only returns the
                // parsing closure, called from collectEsa() below.
                'esa' => $this->esaClient->requestOrbit($designation),
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
            [$esaStatus, $esaOrbit] = $this->collectEsa($pending['esa']);
            if ($esaStatus === 'not_found' && $sbdbStatus === 'ok') {
                $number = $sbdb['object']['des'] ?? '';
                // SBDB's "des" IS the number for a numbered object (kind "an")
                // and the provisional designation itself for an unnumbered one
                // (kind "au") — ctype_digit is cheaper than trusting "kind" to
                // always be present, and means the same thing here. Only retry
                // when that number differs from what was already asked: ESA's
                // download resolves a NUMBERED object by its number alone, not
                // by its provisional designation (measured 2026-10-12:
                // file=2004MN4.ke1/.ke0 both empty for Apophis, file=99942.*
                // isn't) — exactly the well-studied objects this comparison
                // matters most for. Not parallel with the other three requests:
                // the number only exists once SBDB has already answered.
                if (is_string($number) && ctype_digit($number) && $number !== str_replace(' ', '', $designation)) {
                    [$esaStatus, $esaOrbit] = $this->collectEsa($this->esaClient->requestOrbit($number));
                }
            }

            if ($sbdbStatus === 'unavailable' && $ssocardStatus === 'unavailable') {
                // Thrown after the loop, once every response was read (see HttpResponses::settle).
                // ESA plays no part in this: it's a bonus comparison point, never load-bearing.
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
                    $esaOrbit,
                    ['sbdb' => $sbdbStatus, 'ssocard' => $ssocardStatus, 'sentry' => $sentryStatus, 'esa' => $esaStatus],
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

    /**
     * EsaNeoccClient::requestOrbit() never throws itself — parseOrbit() turns
     * every oddity into null — but reading the response inside the closure
     * can still throw a transport failure, same as the three other sources.
     *
     * @param \Closure(): (array<string, mixed>|null) $closure
     *
     * @return array{string, array<string, mixed>|null}
     */
    private function collectEsa(\Closure $closure): array
    {
        try {
            $orbit = $closure();
        } catch (ExceptionInterface) {
            return ['unavailable', null];
        }

        return [$orbit === null ? 'not_found' : 'ok', $orbit];
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

    private static function normalize(string $designation, ?array $sbdb, ?array $ssocard, ?array $sentry, ?array $esaOrbit, array $sources): array
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

        // Computed once so 'orbit' (unchanged) and 'orbits' (new) read the same
        // values instead of two implementations drifting apart. 'orbit' keeps
        // its exact original fallback: ssoCard's elements are only its answer
        // when SBDB itself is absent, even though ssocardOrbit() is always
        // computed below for the 'orbits' side-by-side view.
        $sbdbOrbit = $sbdb !== null ? self::sbdbOrbit($sbdb) : null;
        $ssocardOrbit = self::ssocardOrbit($ssoDynamical['orbital_elements'] ?? null);
        $orbits = ['sbdb' => $sbdbOrbit, 'esa' => $esaOrbit, 'ssocard' => $ssocardOrbit];

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
            'orbit' => $sbdb !== null ? $sbdbOrbit : $ssocardOrbit,
            'orbits' => $orbits,
            'orbit_comparison' => self::compareOrbits($orbits),
            'impact_risk' => $sentry === null ? null : self::impactRisk($sentry),
            'sources' => $sources,
            'links' => [
                'jpl' => 'https://ssd.jpl.nasa.gov/tools/sbdb_lookup.html#/?sstr='.rawurlencode($designation),
                'ssocard' => $ssocard === null ? null : 'https://ssp.imcce.fr/forms/ssocard/'.rawurlencode($ssocard['id'] ?? str_replace(' ', '_', $designation)),
                'esa' => ($sources['esa'] ?? null) === 'ok' ? 'https://neo.ssa.esa.int/search-for-asteroids?sum=1&des='.rawurlencode($designation) : null,
            ],
        ];
    }

    /**
     * How far apart two epochs may sit and still count as "the same" for
     * mean_anomaly_deg's sake. 86 s is generous next to the question that
     * matters (does this orbit sit at today's epoch, or years away?) and
     * tight next to what it protects against: Apophis moves ~1.1°/day, so
     * 86 s of epoch slack is itself worth only ~0.001° — two orders below the
     * spreads an actual epoch mismatch produces (see compareOrbits()).
     */
    private const EPOCH_TOLERANCE_DAYS = 0.001;

    /**
     * Side-by-side orbit disagreement, over the elements the catalogues
     * share: a_au, e, i_deg, node_deg, peri_deg, period_days, and
     * mean_anomaly_deg — but only when every compared source sits at the
     * SAME epoch (see same_epoch below). q_au/ad_au are left out for a
     * different reason: both are a_au(1∓e) by construction, so comparing
     * them would restate a_au and e's own disagreement rather than add one.
     *
     * mean_anomaly_deg needs its own epoch, measured: querying ESA's `.ke0`
     * (its own fit epoch) against Apophis's SBDB/ssoCard (epoch_jd
     * 2461200.5) gave a_au a spread of 2e-4 (relative ~2e-4) — an 8-year-old
     * epoch gap, not a real disagreement, drifting every element in sight,
     * mean anomaly worst of all since it is THE element that moves day by
     * day. Querying `.ke1` instead (propagated to that exact common epoch,
     * see EsaNeoccClient::requestOrbit()) drops the same a_au spread to
     * ~1e-9 — two orders below even the project's own "this is noise"
     * NEOWS_DISTANCE_TOLERANCE of 0.1 %. `same_epoch` is this check made
     * explicit for the client, since EsaNeoccClient preferring `.ke1` only
     * makes this likely, not guaranteed (ssoCard is a weekly snapshot at
     * its own epoch too).
     *
     * i_deg, node_deg, peri_deg and mean_anomaly_deg are angles with no
     * natural zero, so their spread is the worst-case PAIRWISE wrapped
     * difference (359.9995° next to 0.0005° is 0.001° apart, not 359.999°),
     * and their relative deviation is spread ÷ 360 rather than spread ÷ mean.
     *
     * @param array{sbdb: ?array<string, mixed>, esa: ?array<string, mixed>, ssocard: ?array<string, mixed>} $orbits
     *
     * @return ?array{compared: list<string>, same_epoch: bool, spread: array<string, ?float>, worst: ?array{field: string, relative: float}}
     */
    public static function compareOrbits(array $orbits): ?array
    {
        $present = array_filter($orbits, static fn (?array $orbit) => $orbit !== null);
        if (count($present) < 2) {
            return null;
        }

        // ssoCard's own epoch_jd can itself be null (ref_epoch absent from a
        // sparse card) — filtered out here rather than compared against, so
        // a missing epoch degrades to "not the same epoch" instead of a type
        // error from comparing null against a float.
        $epochs = array_filter(array_column($present, 'epoch_jd'), static fn ($epoch) => $epoch !== null);
        $sameEpoch = count($epochs) === count($present) && max($epochs) - min($epochs) <= self::EPOCH_TOLERANCE_DAYS;

        $angleFields = ['i_deg', 'node_deg', 'peri_deg', 'mean_anomaly_deg'];
        $spread = [];
        $worstField = null;
        $worstRelative = -1.0;
        foreach (['a_au', 'e', 'i_deg', 'node_deg', 'peri_deg', 'period_days', 'mean_anomaly_deg'] as $field) {
            if ($field === 'mean_anomaly_deg' && !$sameEpoch) {
                // Forced null, not "skipped" — different epochs, so a value
                // here would look like a measurement and isn't one.
                $spread[$field] = null;
                continue;
            }
            $values = [];
            foreach ($present as $source => $orbit) {
                if (isset($orbit[$field])) {
                    $values[$source] = (float) $orbit[$field];
                }
            }
            if (count($values) < 2) {
                $spread[$field] = null;
                continue;
            }
            $isAngle = in_array($field, $angleFields, true);
            $extent = $isAngle ? self::angularSpread(array_values($values)) : max($values) - min($values);
            $spread[$field] = $extent;

            $mean = array_sum($values) / count($values);
            $relative = $isAngle ? $extent / 360.0 : ($mean !== 0.0 ? $extent / abs($mean) : null);
            if ($relative !== null && $relative > $worstRelative) {
                $worstRelative = $relative;
                $worstField = $field;
            }
        }

        return [
            'compared' => array_keys($present),
            'same_epoch' => $sameEpoch,
            'spread' => $spread,
            'worst' => $worstField === null ? null : ['field' => $worstField, 'relative' => $worstRelative],
        ];
    }

    /** Largest pairwise difference, each wrapped into [-180°, 180°] first — see compareOrbits(). */
    private static function angularSpread(array $values): float
    {
        $max = 0.0;
        $count = count($values);
        for ($i = 0; $i < $count; ++$i) {
            for ($j = $i + 1; $j < $count; ++$j) {
                $max = max($max, abs(self::wrapDegrees($values[$j] - $values[$i])));
            }
        }

        return $max;
    }

    /** Into (-180°, 180°] — fmod() alone keeps PHP's sign, which is wrong for a negative difference. */
    private static function wrapDegrees(float $degrees): float
    {
        $wrapped = fmod($degrees + 180.0, 360.0);
        if ($wrapped < 0.0) {
            $wrapped += 360.0;
        }

        return $wrapped - 180.0;
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
