<?php

namespace App\Service;

/**
 * Small-body naming helpers shared by every NEO source. Each catalogue spells
 * the same object differently — NeoWs/JPL "99942 Apophis (2004 MN4)", ESA
 * "2026RB39" or "524522 Zoozve", Sentry "443104 (2013 XK22)" — so objects are
 * matched on their number when they have one, else on their provisional
 * designation with spaces removed.
 */
final class NeoDesignation
{
    /**
     * Names read "(2014 SU1)", "495615 (2015 PQ291)" or
     * "99942 Apophis (2004 MN4)" — the provisional designation in the last
     * parentheses is what other catalogues (JPL Horizons, IMCCE) accept, while
     * a NeoWs `id` is NeoWs-specific.
     */
    public static function fromName(string $name): string
    {
        if (preg_match('/\(([^()]+)\)\s*$/', $name, $matches)) {
            return trim($matches[1]);
        }

        return trim($name);
    }

    /**
     * Leading asteroid number ("99942 Apophis (2004 MN4)" → "99942"), null when
     * unnumbered. "2014 SU1" is a designation, not number 2014.
     */
    public static function numberFromName(string $name): ?string
    {
        if (preg_match('/^\s*(\d+)(?:\s+(?![A-Z]{2}\d*(?:[\s)]|$))|\s*\(|$)/', $name, $matches)) {
            return $matches[1];
        }

        return null;
    }

    /** ESA packs designations without the space: "2026RB39" → "2026 RB39". Anything else is returned as is. */
    public static function expandCompact(string $designation): string
    {
        return preg_replace('/^(\d{4})([A-Z]{2}\d*)$/', '$1 $2', trim($designation));
    }

    /**
     * Keys under which an object can be found: "n:<number>" and
     * "d:<designation without spaces>". Two rows describe the same object when
     * they share any key.
     *
     * @return list<string>
     */
    public static function matchKeys(?string $number, ?string $designation): array
    {
        $keys = [];
        if ($number !== null && $number !== '') {
            $keys[] = 'n:'.$number;
        }
        if ($designation !== null && $designation !== '') {
            $keys[] = 'd:'.strtoupper(str_replace(' ', '', $designation));
        }

        return $keys;
    }
}
