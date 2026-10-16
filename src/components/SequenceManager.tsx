import { useState, useEffect } from 'react';
// Client-side BPM detection
// Note: dynamic import used inside handler to avoid SSR issues
import { supabase } from '@/integrations/supabase/client';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog';
import { ScrollArea } from '@/components/ui/scroll-area';
import { useToast } from '@/hooks/use-toast';
import { Save, FolderOpen, Trash2, Upload, FilePlus, Share2 } from 'lucide-react';
import { BeatState } from '@/types/sequencer';

interface SequenceManagerProps {
  currentBpm: number;
  currentSequence: BeatState[];
  currentAudioUrl?: string | null;
  currentAudioFileName?: string | null;
  onLoad: (bpm: number, sequence: BeatState[], name: string, audioUrl?: string, audioFileName?: string) => void;
  onBpmDetected?: (bpm: number, duration: number, audioUrl: string, fileName?: string) => void;
  onDialogOpenChange?: (isOpen: boolean) => void;
  onNew?: () => void;
}

interface SavedSequence {
  id: string;
  name: string;
  bpm: number;
  beats: BeatState[];
  audio_url?: string;
  audio_filename?: string;
  created_at: string;
}

export const SequenceManager = ({ currentBpm, currentSequence, currentAudioUrl, currentAudioFileName, onLoad, onBpmDetected, onDialogOpenChange, onNew }: SequenceManagerProps) => {
  const [sequences, setSequences] = useState<SavedSequence[]>([]);
  const [sequenceName, setSequenceName] = useState('');
  const [saveDialogOpen, setSaveDialogOpen] = useState(false);
  const [loadDialogOpen, setLoadDialogOpen] = useState(false);
  const [uploadDialogOpen, setUploadDialogOpen] = useState(false);
  const [overrideDialogOpen, setOverrideDialogOpen] = useState(false);
  const [newDialogOpen, setNewDialogOpen] = useState(false);
  const [shareDialogOpen, setShareDialogOpen] = useState(false);
  const [existingSequence, setExistingSequence] = useState<SavedSequence | null>(null);
  const [shareEmail, setShareEmail] = useState('');
  const [sharing, setSharing] = useState(false);
  const [currentSequenceName, setCurrentSequenceName] = useState<string>('');
  const [currentSequenceId, setCurrentSequenceId] = useState<string | null>(null);

  const [uploading, setUploading] = useState(false);
  
  // Notify parent when any dialog opens/closes
  useEffect(() => {
    if (onDialogOpenChange) {
      onDialogOpenChange(saveDialogOpen || loadDialogOpen || uploadDialogOpen || overrideDialogOpen || newDialogOpen || shareDialogOpen);
    }
  }, [saveDialogOpen, loadDialogOpen, uploadDialogOpen, overrideDialogOpen, newDialogOpen, shareDialogOpen, onDialogOpenChange]);
  const { toast } = useToast();

  useEffect(() => {
    loadSequences();
  }, []);

  const loadSequences = async () => {
    const { data, error } = await supabase
      .from('sequences')
      .select('*')
      .order('created_at', { ascending: false });

    if (error) {
      toast({
        title: "Error",
        description: "Failed to load sequences",
        variant: "destructive",
      });
      return;
    }

    setSequences((data || []).map(seq => ({
      ...seq,
      beats: seq.beats as unknown as BeatState[]
    })));
  };

  const handleSave = async () => {
    if (!sequenceName.trim()) {
      toast({
        title: "Error",
        description: "Please enter a sequence name",
        variant: "destructive",
      });
      return;
    }

    const { data: { user } } = await supabase.auth.getUser();
    if (!user) {
      toast({
        title: "Error",
        description: "You must be logged in to save sequences",
        variant: "destructive",
      });
      return;
    }

    // Check for duplicate name
    const existing = sequences.find(seq => seq.name.toLowerCase() === sequenceName.trim().toLowerCase());
    if (existing) {
      setExistingSequence(existing);
      setOverrideDialogOpen(true);
      return;
    }

    await saveSequence(user.id);
  };

  const saveSequence = async (userId: string, override = false) => {
    const { data, error } = await supabase
      .from('sequences')
      .insert([{
        name: sequenceName.trim(),
        bpm: currentBpm,
        beats: currentSequence as any,
        audio_url: currentAudioUrl,
        audio_filename: currentAudioFileName,
        user_id: userId,
      }])
      .select()
      .single();

    if (error) {
      toast({
        title: "Error",
        description: "Failed to save sequence",
        variant: "destructive",
      });
      return;
    }

    // Update current sequence tracking
    if (data) {
      setCurrentSequenceName(sequenceName.trim());
      setCurrentSequenceId(data.id);
    }

    toast({
      title: "Success",
      description: override ? "Sequence overridden successfully" : "Sequence saved successfully",
    });

    setSequenceName('');
    setSaveDialogOpen(false);
    setOverrideDialogOpen(false);
    setExistingSequence(null);
    loadSequences();
  };

  const handleOverride = async () => {
    if (!existingSequence) return;

    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return;

    // Delete existing sequence
    const { error: deleteError } = await supabase
      .from('sequences')
      .delete()
      .eq('id', existingSequence.id);

    if (deleteError) {
      toast({
        title: "Error",
        description: "Failed to override sequence",
        variant: "destructive",
      });
      return;
    }

    // Save new sequence
    await saveSequence(user.id, true);
  };

  const handleSaveAsNew = () => {
    setOverrideDialogOpen(false);
    setExistingSequence(null);
    // Keep the dialog open so user can modify the name
  };

  const handleLoad = (sequence: SavedSequence) => {
    onLoad(sequence.bpm, sequence.beats, sequence.name, sequence.audio_url, sequence.audio_filename);
    setCurrentSequenceName(sequence.name);
    setCurrentSequenceId(sequence.id);
    setLoadDialogOpen(false);
    toast({
      title: "Success",
      description: `Loaded sequence: ${sequence.name}${sequence.audio_filename ? ` with audio: ${sequence.audio_filename}` : ''}`,
    });
  };

  const handleDelete = async (id: string) => {
    const { error } = await supabase
      .from('sequences')
      .delete()
      .eq('id', id);

    if (error) {
      toast({
        title: "Error",
        description: "Failed to delete sequence",
        variant: "destructive",
      });
      return;
    }

    toast({
      title: "Success",
      description: "Sequence deleted",
    });
    loadSequences();
  };

  const handleAudioUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    if (!file.type.includes('audio')) {
      toast({
        title: "Error",
        description: "Please upload an audio file",
        variant: "destructive",
      });
      return;
    }

    setUploading(true);

    try {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) throw new Error('Not authenticated');

      // Upload file to storage
      const fileName = `${user.id}/${Date.now()}_${file.name}`;
      const { error: uploadError } = await supabase.storage
        .from('audio-files')
        .upload(fileName, file);

      if (uploadError) throw uploadError;

      // Get public URL
      const { data: { publicUrl } } = supabase.storage
        .from('audio-files')
        .getPublicUrl(fileName);

      // Prefer client-side BPM detection for accuracy
      try {
        const response = await fetch(publicUrl);
        const arrayBuffer = await response.arrayBuffer();
        const audioCtx = new (window.AudioContext || (window as any).webkitAudioContext)();
        const audioBuffer = await audioCtx.decodeAudioData(arrayBuffer.slice(0));
        const { default: detectBpm } = await import('bpm-detective');
        const detectedBpm = detectBpm(audioBuffer);
        
        if (onBpmDetected) {
          onBpmDetected(Math.round(detectedBpm), audioBuffer.duration, publicUrl, file.name);
        }
        
        toast({
          title: "BPM Detected!",
          description: `BPM: ${Math.round(detectedBpm)}, Duration: ${audioBuffer.duration.toFixed(2)}s`,
        });
      } catch (clientErr) {
        console.warn('Client-side BPM detection failed, falling back to backend:', clientErr);
        const { data, error } = await supabase.functions.invoke('detect-bpm', {
          body: { audioUrl: publicUrl },
        });
        if (error) throw error;
        if (data.bpm && onBpmDetected) {
          onBpmDetected(data.bpm, data.duration, publicUrl, file.name);
          toast({
            title: "BPM Detected!",
            description: `BPM: ${data.bpm}, Duration: ${data.duration.toFixed(2)}s`,
          });
        }
      }

      setUploadDialogOpen(false);
    } catch (error: any) {
      toast({
        title: "Error",
        description: error.message || "Failed to process audio file",
        variant: "destructive",
      });
    } finally {
      setUploading(false);
    }
  };

  const handleNew = () => {
    // Check if there's any sequence data
    if (currentSequence.length > 0) {
      setNewDialogOpen(true);
    } else {
      // If no data, just create new directly
      if (onNew) onNew();
    }
  };

  const confirmNew = () => {
    if (onNew) onNew();
    setCurrentSequenceName('');
    setCurrentSequenceId(null);
    setNewDialogOpen(false);
  };

  const handleShare = async () => {
    if (!shareEmail.trim()) {
      toast({
        title: "Error",
        description: "Please enter an email address",
        variant: "destructive",
      });
      return;
    }

    // Email validation
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(shareEmail.trim())) {
      toast({
        title: "Error",
        description: "Please enter a valid email address",
        variant: "destructive",
      });
      return;
    }

    if (!currentSequenceId) {
      toast({
        title: "Error",
        description: "Please save or load a sequence first",
        variant: "destructive",
      });
      return;
    }

    setSharing(true);

    try {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) {
        toast({
          title: "Error",
          description: "You must be logged in to share sequences",
          variant: "destructive",
        });
        return;
      }

      // Create share record
      const { data: shareData, error: shareError } = await supabase
        .from('shared_sequences')
        .insert([{
          sequence_id: currentSequenceId,
          shared_by: user.id,
          shared_with_email: shareEmail.trim().toLowerCase(),
        }])
        .select()
        .single();

      if (shareError) throw shareError;

      // Send email notification
      const { error: emailError } = await supabase.functions.invoke('share-sequence', {
        // The function reads the recipient, sequence name and sender from
        // the share row and the signed-in session, not from this body.
        body: {
          shareToken: shareData.token,
          appUrl: window.location.origin,
        },
      });

      if (emailError) throw emailError;

      toast({
        title: "Success",
        description: `Sequence shared with ${shareEmail}`,
      });

      setShareEmail('');
      setShareDialogOpen(false);
    } catch (error: any) {
      toast({
        title: "Error",
        description: error.message || "Failed to share sequence",
        variant: "destructive",
      });
    } finally {
      setSharing(false);
    }
  };

  return (
    <div className="flex gap-2">
      <Dialog open={newDialogOpen} onOpenChange={setNewDialogOpen}>
        <DialogTrigger asChild>
          <Button variant="outline" size="sm" className="bg-gray-800 border-gray-700 text-white hover:bg-gray-700 h-8 px-2 text-xs" onClick={handleNew}>
            <FilePlus className="w-3 h-3 mr-1" />
            New
          </Button>
        </DialogTrigger>
        <DialogContent className="bg-gray-900 border-green-500/20 text-white">
          <DialogHeader>
            <DialogTitle className="text-green-500">Create New Sequence</DialogTitle>
            <DialogDescription className="text-gray-400">
              This will override the currently loaded sequence and cannot be undone.
            </DialogDescription>
          </DialogHeader>
          <div className="flex gap-2">
            <Button 
              onClick={() => setNewDialogOpen(false)} 
              variant="outline"
              className="flex-1 bg-gray-800 border-gray-700 text-white hover:bg-gray-700"
            >
              Cancel
            </Button>
            <Button 
              onClick={confirmNew} 
              className="flex-1 bg-green-500 hover:bg-green-600 text-black"
            >
              OK
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      <Dialog open={saveDialogOpen} onOpenChange={setSaveDialogOpen}>
        <DialogTrigger asChild>
          <Button variant="outline" size="sm" className="bg-gray-800 border-gray-700 text-white hover:bg-gray-700 h-8 px-2 text-xs">
            <Save className="w-3 h-3 mr-1" />
            Save
          </Button>
        </DialogTrigger>
        <DialogContent className="bg-gray-900 border-green-500/20 text-white">
          <DialogHeader>
            <DialogTitle className="text-green-500">Save Sequence</DialogTitle>
            <DialogDescription className="text-gray-400">
              Enter a name for your sequence
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <Input
              placeholder="Sequence name"
              value={sequenceName}
              onChange={(e) => setSequenceName(e.target.value)}
              className="bg-gray-800 border-gray-700 text-white"
            />
            <Button onClick={handleSave} className="w-full bg-green-500 hover:bg-green-600 text-black">
              Save
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      <Dialog open={shareDialogOpen} onOpenChange={setShareDialogOpen}>
        <DialogTrigger asChild>
          <Button 
            variant="outline" 
            size="sm" 
            className="bg-gray-800 border-gray-700 text-white hover:bg-gray-700 h-8 px-2 text-xs"
            disabled={!currentSequenceId}
          >
            <Share2 className="w-3 h-3 mr-1" />
            Share
          </Button>
        </DialogTrigger>
        <DialogContent className="bg-gray-900 border-green-500/20 text-white">
          <DialogHeader>
            <DialogTitle className="text-green-500">Share Sequence</DialogTitle>
            <DialogDescription className="text-gray-400">
              Enter the email address of the person you'd like to share this sequence with
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <Input
              type="email"
              placeholder="recipient@example.com"
              value={shareEmail}
              onChange={(e) => setShareEmail(e.target.value)}
              className="bg-gray-800 border-gray-700 text-white"
              disabled={sharing}
            />
            <Button 
              onClick={handleShare} 
              className="w-full bg-green-500 hover:bg-green-600 text-black"
              disabled={sharing}
            >
              {sharing ? 'Sharing...' : 'Send Invitation'}
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      <Dialog open={loadDialogOpen} onOpenChange={setLoadDialogOpen}>
        <DialogTrigger asChild>
          <Button variant="outline" size="sm" className="bg-gray-800 border-gray-700 text-white hover:bg-gray-700 h-8 px-2 text-xs">
            <FolderOpen className="w-3 h-3 mr-1" />
            Load
          </Button>
        </DialogTrigger>
        <DialogContent className="bg-gray-900 border-green-500/20 text-white">
          <DialogHeader>
            <DialogTitle className="text-green-500">Load Sequence</DialogTitle>
            <DialogDescription className="text-gray-400">
              Select a sequence to load
            </DialogDescription>
          </DialogHeader>
          <ScrollArea className="h-[300px] pr-4">
            {sequences.length === 0 ? (
              <p className="text-gray-400 text-center py-8">No saved sequences</p>
            ) : (
              <div className="space-y-2">
                {sequences.map((seq) => (
                  <div
                    key={seq.id}
                    className="flex items-center justify-between p-3 bg-gray-800 rounded-md"
                  >
                    <div className="flex-1">
                      <p className="font-medium text-white">{seq.name}</p>
                      <p className="text-sm text-gray-400">
                        {seq.bpm} BPM • {seq.beats.length} beats
                        {seq.audio_filename && ` • 🎵 ${seq.audio_filename}`}
                      </p>
                    </div>
                    <div className="flex gap-2">
                      <Button
                        size="sm"
                        onClick={() => handleLoad(seq)}
                        className="bg-green-500 hover:bg-green-600 text-black"
                      >
                        Load
                      </Button>
                      <Button
                        size="sm"
                        variant="destructive"
                        onClick={() => handleDelete(seq.id)}
                      >
                        <Trash2 className="w-4 h-4" />
                      </Button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </ScrollArea>
        </DialogContent>
      </Dialog>

      <Dialog open={uploadDialogOpen} onOpenChange={setUploadDialogOpen}>
        <DialogTrigger asChild>
          <Button variant="outline" size="sm" className="bg-gray-800 border-gray-700 text-white hover:bg-gray-700 h-8 px-2 text-xs">
            <Upload className="w-3 h-3 mr-1" />
            Upload MP3
          </Button>
        </DialogTrigger>
        <DialogContent className="bg-gray-900 border-green-500/20 text-white">
          <DialogHeader>
            <DialogTitle className="text-green-500">Upload Audio File</DialogTitle>
            <DialogDescription className="text-gray-400">
              Upload an MP3 file to detect its BPM
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <Input
              type="file"
              accept="audio/*"
              onChange={handleAudioUpload}
              disabled={uploading}
              className="bg-gray-800 border-gray-700 text-white"
            />
            {uploading && (
              <p className="text-gray-400 text-sm">Processing audio file...</p>
            )}
          </div>
        </DialogContent>
      </Dialog>

      <Dialog open={overrideDialogOpen} onOpenChange={setOverrideDialogOpen}>
        <DialogContent className="bg-gray-900 border-green-500/20 text-white">
          <DialogHeader>
            <DialogTitle className="text-green-500">Sequence Already Exists</DialogTitle>
            <DialogDescription className="text-gray-400">
              A sequence named "{sequenceName}" already exists. Would you like to override it or save as a new sequence?
            </DialogDescription>
          </DialogHeader>
          <div className="flex gap-2">
            <Button 
              onClick={handleOverride} 
              className="flex-1 bg-amber-500 hover:bg-amber-600 text-black"
            >
              Override Existing
            </Button>
            <Button 
              onClick={handleSaveAsNew} 
              className="flex-1 bg-green-500 hover:bg-green-600 text-black"
            >
              Save as New
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
};
