CREATE OR REPLACE FUNCTION public.server_validation_guard() RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
 IF coalesce(auth.role(), '') <> 'service_role' AND current_user <> 'postgres' THEN
  IF TG_OP = 'INSERT' THEN
   IF NEW.status <> 'uploaded' OR NEW.file_path IS NOT NULL OR NEW.manifest <> '{}'::jsonb OR NEW.validation_report <> '{}'::jsonb THEN
    RAISE EXCEPTION 'Only server validation can approve uploaded files';
   END IF;
  ELSE
   IF NEW.status IS DISTINCT FROM OLD.status OR NEW.file_path IS DISTINCT FROM OLD.file_path OR NEW.manifest IS DISTINCT FROM OLD.manifest OR NEW.validation_report IS DISTINCT FROM OLD.validation_report THEN
    RAISE EXCEPTION 'Only server validation can approve uploaded files';
   END IF;
  END IF;
 END IF;
 IF TG_OP = 'UPDATE' AND NEW.upload_path IS DISTINCT FROM OLD.upload_path AND NEW.upload_path IS NOT NULL THEN
  NEW.status := 'uploaded'; NEW.published := false;
 END IF;
 IF NEW.published AND (NEW.status <> 'validated' OR NEW.file_path IS NULL OR coalesce((NEW.validation_report->>'ok')::boolean, false) IS NOT TRUE) THEN
  RAISE EXCEPTION 'Validate this file before publishing';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER a_server_validation_guard BEFORE INSERT OR UPDATE ON public.packs FOR EACH ROW EXECUTE FUNCTION public.server_validation_guard();
CREATE OR REPLACE FUNCTION public.release_validation_guard() RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
 IF coalesce(auth.role(), '') <> 'service_role' AND current_user <> 'postgres' THEN
  IF TG_OP = 'INSERT' THEN
   IF NEW.status <> 'uploaded' OR NEW.file_path IS NOT NULL OR NEW.sha256 IS NOT NULL OR NEW.validation_report <> '{}'::jsonb THEN
    RAISE EXCEPTION 'Only server validation can approve APKs';
   END IF;
  ELSE
   IF NEW.status IS DISTINCT FROM OLD.status OR NEW.file_path IS DISTINCT FROM OLD.file_path OR NEW.sha256 IS DISTINCT FROM OLD.sha256 OR NEW.validation_report IS DISTINCT FROM OLD.validation_report THEN
    RAISE EXCEPTION 'Only server validation can approve APKs';
   END IF;
   IF NEW.status = 'validated' AND (NEW.version_code IS DISTINCT FROM OLD.version_code OR NEW.package_name IS DISTINCT FROM OLD.package_name OR NEW.min_sdk IS DISTINCT FROM OLD.min_sdk) THEN
    RAISE EXCEPTION 'Upload a new release to change validated package details';
   END IF;
  END IF;
 END IF;
 IF TG_OP = 'UPDATE' AND NEW.upload_path IS DISTINCT FROM OLD.upload_path AND NEW.upload_path IS NOT NULL THEN NEW.status := 'uploaded'; NEW.published := false; END IF;
 IF NEW.published AND (NEW.status <> 'validated' OR NEW.file_path IS NULL OR NEW.sha256 IS NULL OR NEW.sha256 !~ '^[a-f0-9]{64}$' OR coalesce((NEW.validation_report->>'ok')::boolean, false) IS NOT TRUE) THEN
  RAISE EXCEPTION 'Validate this APK before publishing';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER a_release_validation_guard BEFORE INSERT OR UPDATE ON public.app_releases FOR EACH ROW EXECUTE FUNCTION public.release_validation_guard();