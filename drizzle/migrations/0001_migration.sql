create policy "Admins upload incoming" on storage.objects for insert to authenticated
  with check (bucket_id = 'incoming' and public.has_role(auth.uid(),'admin'));
create policy "Admins read incoming" on storage.objects for select to authenticated
  using (bucket_id = 'incoming' and public.has_role(auth.uid(),'admin'));
create policy "Admins delete incoming" on storage.objects for delete to authenticated
  using (bucket_id = 'incoming' and public.has_role(auth.uid(),'admin'));
create policy "Admins read packs objects" on storage.objects for select to authenticated
  using (bucket_id = 'packs' and public.has_role(auth.uid(),'admin'));
create policy "Admins delete packs objects" on storage.objects for delete to authenticated
  using (bucket_id = 'packs' and public.has_role(auth.uid(),'admin'));