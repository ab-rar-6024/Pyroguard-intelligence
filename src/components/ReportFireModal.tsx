import React, { useEffect, useRef, useState } from 'react';
import L from 'leaflet';
import { X, Flame, MapPin, Navigation, Camera, Loader2, CheckCircle2, AlertTriangle } from 'lucide-react';
import { apiUrl } from '../utils/apiBase';

interface ReportFireModalProps {
  onClose: () => void;
  onSubmitted?: () => void;
}

const MAX_DIMENSION = 1024;

// Resizes/compresses the photo client-side so the base64 payload stays
// well under Firestore's 1MiB document limit (and the server's 3MB JSON
// body limit) - a raw phone camera photo can be 5-10MB.
function compressImage(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('Could not read the selected file.'));
    reader.onload = () => {
      const img = new Image();
      img.onerror = () => reject(new Error('Could not decode the selected image.'));
      img.onload = () => {
        let { width, height } = img;
        if (width > height && width > MAX_DIMENSION) {
          height = Math.round((height * MAX_DIMENSION) / width);
          width = MAX_DIMENSION;
        } else if (height > MAX_DIMENSION) {
          width = Math.round((width * MAX_DIMENSION) / height);
          height = MAX_DIMENSION;
        }
        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext('2d');
        if (!ctx) return reject(new Error('Canvas is not supported in this browser.'));
        ctx.drawImage(img, 0, 0, width, height);

        let quality = 0.75;
        let dataUrl = canvas.toDataURL('image/jpeg', quality);
        while (dataUrl.length > 700_000 && quality > 0.3) {
          quality -= 0.15;
          dataUrl = canvas.toDataURL('image/jpeg', quality);
        }
        resolve(dataUrl);
      };
      img.src = reader.result as string;
    };
    reader.readAsDataURL(file);
  });
}

export const ReportFireModal: React.FC<ReportFireModalProps> = ({ onClose, onSubmitted }) => {
  const mapContainerRef = useRef<HTMLDivElement>(null);
  const mapInstanceRef = useRef<L.Map | null>(null);
  const markerRef = useRef<L.Marker | null>(null);

  const [position, setPosition] = useState<{ lat: number; lon: number } | null>(null);
  const [locationSource, setLocationSource] = useState<'gps' | 'map' | null>(null);
  const [locatingGps, setLocatingGps] = useState(false);
  const [gpsError, setGpsError] = useState<string | null>(null);

  const [landmark, setLandmark] = useState('');
  const [description, setDescription] = useState('');

  const [imagePreview, setImagePreview] = useState<string | null>(null);
  const [compressing, setCompressing] = useState(false);
  const [imageError, setImageError] = useState<string | null>(null);

  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [submitted, setSubmitted] = useState(false);

  const placeMarker = (lat: number, lon: number, map: L.Map) => {
    if (markerRef.current) {
      markerRef.current.setLatLng([lat, lon]);
    } else {
      const icon = L.divIcon({
        className: '',
        html: `<div style="width:20px;height:20px;border-radius:50%;background:#f97316;border:3px solid white;box-shadow:0 0 0 2px rgba(249,115,22,0.5)"></div>`,
        iconSize: [20, 20],
        iconAnchor: [10, 10]
      });
      markerRef.current = L.marker([lat, lon], { icon, draggable: true }).addTo(map);
      markerRef.current.on('dragend', () => {
        const ll = markerRef.current!.getLatLng();
        setPosition({ lat: ll.lat, lon: ll.lng });
        setLocationSource('map');
      });
    }
  };

  useEffect(() => {
    if (!mapContainerRef.current || mapInstanceRef.current) return;
    const map = L.map(mapContainerRef.current, {
      center: [20, 0],
      zoom: 2,
      zoomControl: true,
      attributionControl: false
    });
    L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Base/MapServer/tile/{z}/{y}/{x}', {
      maxZoom: 16
    }).addTo(map);
    map.on('click', (e: L.LeafletMouseEvent) => {
      setPosition({ lat: e.latlng.lat, lon: e.latlng.lng });
      setLocationSource('map');
      placeMarker(e.latlng.lat, e.latlng.lng, map);
    });
    mapInstanceRef.current = map;

    return () => {
      map.remove();
      mapInstanceRef.current = null;
      markerRef.current = null;
    };
  }, []);

  useEffect(() => {
    if (position && mapInstanceRef.current) {
      mapInstanceRef.current.setView([position.lat, position.lon], Math.max(mapInstanceRef.current.getZoom(), 12));
      placeMarker(position.lat, position.lon, mapInstanceRef.current);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [position?.lat, position?.lon]);

  const useMyLocation = () => {
    setGpsError(null);
    if (!navigator.geolocation) {
      setGpsError('Your browser does not support location access.');
      return;
    }
    setLocatingGps(true);

    const onSuccess = (pos: GeolocationPosition) => {
      setPosition({ lat: pos.coords.latitude, lon: pos.coords.longitude });
      setLocationSource('gps');
      setLocatingGps(false);
    };

    const describeError = (err: GeolocationPositionError) => {
      if (err.code === err.PERMISSION_DENIED) {
        return 'Location access was denied. Allow location for this site in your browser settings, or pick it on the map instead.';
      }
      return 'Could not get your live location (it may be slow indoors or on desktop). Please pick it on the map instead.';
    };

    // A GPS hardware fix (enableHighAccuracy) can take much longer than a
    // typical timeout to lock, especially indoors or on a desktop with no
    // GPS chip at all - that's the common cause of a timeout error here.
    // Retry once with a coarser, much faster network/Wi-Fi-based fix (and a
    // longer budget) before giving up and pointing the user at the map.
    navigator.geolocation.getCurrentPosition(
      onSuccess,
      (err) => {
        if (err.code === err.PERMISSION_DENIED) {
          setGpsError(describeError(err));
          setLocatingGps(false);
          return;
        }
        navigator.geolocation.getCurrentPosition(
          onSuccess,
          (err2) => {
            setGpsError(describeError(err2));
            setLocatingGps(false);
          },
          { enableHighAccuracy: false, timeout: 15000, maximumAge: 300000 }
        );
      },
      { enableHighAccuracy: true, timeout: 8000, maximumAge: 60000 }
    );
  };

  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setImageError(null);
    setCompressing(true);
    try {
      const compressed = await compressImage(file);
      setImagePreview(compressed);
    } catch (err: any) {
      setImageError(err.message || 'Failed to process the photo.');
    } finally {
      setCompressing(false);
    }
  };

  const canSubmit = position && locationSource && imagePreview && !submitting && !compressing;

  const handleSubmit = async () => {
    if (!canSubmit || !position || !locationSource || !imagePreview) return;
    setSubmitting(true);
    setSubmitError(null);
    try {
      const res = await fetch(apiUrl('/api/reports/fire'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          latitude: position.lat,
          longitude: position.lon,
          locationSource,
          landmark: landmark.trim() || undefined,
          description: description.trim() || undefined,
          imageBase64: imagePreview
        })
      });
      const data = await res.json();
      if (!data.success) throw new Error(data.error || 'Failed to submit the report.');
      setSubmitted(true);
      onSubmitted?.();
    } catch (err: any) {
      setSubmitError(err.message || 'Failed to submit the report.');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="fixed inset-0 z-[9999] flex items-center justify-center p-3 sm:p-4 bg-slate-950/85 backdrop-blur-md">
      <div className="bg-slate-950 border border-slate-800 rounded-2xl w-full max-w-xl max-h-[92vh] shadow-2xl overflow-hidden flex flex-col text-slate-100">

        <div className="flex items-center justify-between p-4 border-b border-slate-800 bg-slate-900/60 flex-shrink-0">
          <div className="flex items-center gap-2.5">
            <div className="p-2 rounded-lg bg-orange-950/70 border border-orange-500/40 text-orange-400">
              <Flame className="w-5 h-5" />
            </div>
            <div>
              <h2 className="text-sm font-bold text-slate-100">Report a Fire Sighting</h2>
              <p className="text-xs text-slate-400">Seen a fire the satellite hasn't caught yet? Help fill the gap.</p>
            </div>
          </div>
          <button onClick={onClose} className="p-1.5 rounded-lg hover:bg-slate-800 text-slate-400 hover:text-slate-100 transition-colors cursor-pointer">
            <X className="w-5 h-5" />
          </button>
        </div>

        {submitted ? (
          <div className="p-8 flex flex-col items-center text-center gap-3">
            <CheckCircle2 className="w-12 h-12 text-emerald-400" />
            <h3 className="text-sm font-bold text-slate-100">Report saved</h3>
            <p className="text-xs text-slate-400 max-w-sm">
              Your sighting has been stored and will show up under Incident History &gt; Citizen Reports for cross-checking
              against satellite data.
            </p>
            <button
              onClick={onClose}
              className="mt-2 px-4 py-2 rounded-xl bg-orange-600 hover:bg-orange-500 text-white text-sm font-bold transition-colors cursor-pointer"
            >
              Done
            </button>
          </div>
        ) : (
          <div className="p-4 sm:p-5 overflow-y-auto flex-1 space-y-4">
            <div className="p-2.5 rounded-lg bg-amber-950/20 border border-amber-500/30 text-[11px] text-amber-300 flex items-start gap-2">
              <AlertTriangle className="w-3.5 h-3.5 flex-shrink-0 mt-0.5" />
              <span>This is a ground-truth report for cross-checking, not an emergency dispatch. If this is life-threatening, contact local emergency services directly.</span>
            </div>

            <div>
              <label className="text-xs font-bold text-slate-300 mb-1.5 block">1. Location</label>
              <div className="flex gap-2 mb-2">
                <button
                  onClick={useMyLocation}
                  disabled={locatingGps}
                  className="flex items-center gap-1.5 px-3 py-2 rounded-lg bg-slate-900 border border-slate-800 hover:border-orange-500/40 text-slate-200 text-xs font-bold transition-colors cursor-pointer disabled:opacity-50"
                >
                  {locatingGps ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Navigation className="w-3.5 h-3.5" />}
                  Use My Live Location
                </button>
                <span className="text-[11px] text-slate-500 self-center">or click/drag the pin on the map</span>
              </div>
              {gpsError && <p className="text-[11px] text-rose-400 mb-2">{gpsError}</p>}
              <div ref={mapContainerRef} className="w-full h-56 rounded-lg overflow-hidden border border-slate-800" />
              <p className="text-[11px] text-slate-500 mt-1.5 flex items-center gap-1">
                <MapPin className="w-3 h-3" />
                {position
                  ? `${position.lat.toFixed(4)}, ${position.lon.toFixed(4)} (${locationSource === 'gps' ? 'from your device location' : 'picked on map'})`
                  : 'No location set yet'}
              </p>
            </div>

            <div>
              <label className="text-xs font-bold text-slate-300 mb-1.5 block">2. Landmark (optional)</label>
              <input
                type="text"
                value={landmark}
                onChange={(e) => setLandmark(e.target.value)}
                placeholder="e.g. behind the water tank, near the old grain mill"
                maxLength={200}
                className="w-full px-3 py-2 rounded-lg bg-slate-900 border border-slate-800 text-slate-100 text-xs placeholder:text-slate-600 focus:outline-none focus:border-orange-500/50"
              />
            </div>

            <div>
              <label className="text-xs font-bold text-slate-300 mb-1.5 block">3. What do you see? (optional)</label>
              <textarea
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="Smoke color, flame size, how fast it's spreading..."
                maxLength={1000}
                rows={2}
                className="w-full px-3 py-2 rounded-lg bg-slate-900 border border-slate-800 text-slate-100 text-xs placeholder:text-slate-600 focus:outline-none focus:border-orange-500/50 resize-none"
              />
            </div>

            <div>
              <label className="text-xs font-bold text-slate-300 mb-1.5 block">4. Reference photo (required, to verify authenticity)</label>
              <label className="flex items-center gap-2 px-3 py-2 rounded-lg bg-slate-900 border border-slate-800 hover:border-orange-500/40 text-slate-200 text-xs font-bold transition-colors cursor-pointer w-fit">
                <Camera className="w-3.5 h-3.5" />
                {imagePreview ? 'Change Photo' : 'Attach / Take Photo'}
                <input
                  type="file"
                  accept="image/*"
                  capture="environment"
                  onChange={handleFileChange}
                  className="absolute w-px h-px p-0 -m-px overflow-hidden whitespace-nowrap border-0"
                  style={{ clip: 'rect(0,0,0,0)' }}
                />
              </label>
              {compressing && <p className="text-[11px] text-slate-400 mt-1.5 flex items-center gap-1"><Loader2 className="w-3 h-3 animate-spin" /> Processing photo...</p>}
              {imageError && <p className="text-[11px] text-rose-400 mt-1.5">{imageError}</p>}
              {imagePreview && (
                <img src={imagePreview} alt="Fire sighting preview" className="mt-2 max-h-40 rounded-lg border border-slate-800" />
              )}
            </div>

            {submitError && (
              <div className="p-2.5 rounded-lg bg-rose-950/30 border border-rose-500/30 text-[11px] text-rose-300">
                {submitError}
              </div>
            )}

            <button
              onClick={handleSubmit}
              disabled={!canSubmit}
              className="w-full py-2.5 rounded-xl bg-orange-600 hover:bg-orange-500 disabled:bg-slate-800 disabled:text-slate-500 text-white text-sm font-bold transition-colors cursor-pointer flex items-center justify-center gap-2"
            >
              {submitting ? <Loader2 className="w-4 h-4 animate-spin" /> : <Flame className="w-4 h-4" />}
              Submit Report
            </button>
          </div>
        )}
      </div>
    </div>
  );
};
