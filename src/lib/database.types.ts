export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  // Allows to automatically instantiate createClient with right options
  // instead of createClient<Database, { PostgrestVersion: 'XX' }>(URL, KEY)
  __InternalSupabase: {
    PostgrestVersion: "14.5"
  }
  graphql_public: {
    Tables: {
      [_ in never]: never
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      graphql: {
        Args: {
          extensions?: Json
          operationName?: string
          query?: string
          variables?: Json
        }
        Returns: Json
      }
    }
    Enums: {
      [_ in never]: never
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
  public: {
    Tables: {
      app_settings: {
        Row: {
          gps_tolerance_minutes: number
          id: string
          inspection_max_duration_seconds: number
          inspection_min_duration_seconds: number
          overtime_alert_hours: number
          overtime_warning_hours: number
          prolonged_stop_minutes: number
          service_due_hours_warning: number
          service_due_km_warning: number
          updated_at: string
        }
        Insert: {
          gps_tolerance_minutes?: number
          id?: string
          inspection_max_duration_seconds?: number
          inspection_min_duration_seconds?: number
          overtime_alert_hours?: number
          overtime_warning_hours?: number
          prolonged_stop_minutes?: number
          service_due_hours_warning?: number
          service_due_km_warning?: number
          updated_at?: string
        }
        Update: {
          gps_tolerance_minutes?: number
          id?: string
          inspection_max_duration_seconds?: number
          inspection_min_duration_seconds?: number
          overtime_alert_hours?: number
          overtime_warning_hours?: number
          prolonged_stop_minutes?: number
          service_due_hours_warning?: number
          service_due_km_warning?: number
          updated_at?: string
        }
        Relationships: []
      }
      clients: {
        Row: {
          billing_address: string
          contact_name: string
          created_at: string
          email: string
          id: string
          name: string
          notes: string
          phone: string
          rate_table_id: string | null
          status: string
          tickets_auto_bill_enabled: boolean
          tickets_balance: number
          tickets_bundle_price: number
          tickets_bundle_size: number
          tickets_enabled: boolean
          tickets_report_frequency: Database["public"]["Enums"]["ticket_report_frequency"]
          tickets_report_recipients: string[]
          tickets_threshold: number
        }
        Insert: {
          billing_address: string
          contact_name: string
          created_at?: string
          email: string
          id: string
          name: string
          notes?: string
          phone: string
          rate_table_id?: string | null
          status?: string
          tickets_auto_bill_enabled?: boolean
          tickets_balance?: number
          tickets_bundle_price?: number
          tickets_bundle_size?: number
          tickets_enabled?: boolean
          tickets_report_frequency?: Database["public"]["Enums"]["ticket_report_frequency"]
          tickets_report_recipients?: string[]
          tickets_threshold?: number
        }
        Update: {
          billing_address?: string
          contact_name?: string
          created_at?: string
          email?: string
          id?: string
          name?: string
          notes?: string
          phone?: string
          rate_table_id?: string | null
          status?: string
          tickets_auto_bill_enabled?: boolean
          tickets_balance?: number
          tickets_bundle_price?: number
          tickets_bundle_size?: number
          tickets_enabled?: boolean
          tickets_report_frequency?: Database["public"]["Enums"]["ticket_report_frequency"]
          tickets_report_recipients?: string[]
          tickets_threshold?: number
        }
        Relationships: [
          {
            foreignKeyName: "clients_rate_table_fk"
            columns: ["rate_table_id"]
            isOneToOne: false
            referencedRelation: "rate_tables"
            referencedColumns: ["id"]
          },
        ]
      }
      dead_letter_submissions: {
        Row: {
          id: string
          kind: string
          last_attempt_at: string | null
          last_error: string | null
          moved_to_dead_letter_at: string
          payload: Json
          queued_at: string
          retry_count: number
          user_id: string | null
        }
        Insert: {
          id?: string
          kind: string
          last_attempt_at?: string | null
          last_error?: string | null
          moved_to_dead_letter_at?: string
          payload: Json
          queued_at: string
          retry_count?: number
          user_id?: string | null
        }
        Update: {
          id?: string
          kind?: string
          last_attempt_at?: string | null
          last_error?: string | null
          moved_to_dead_letter_at?: string
          payload?: Json
          queued_at?: string
          retry_count?: number
          user_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "dead_letter_submissions_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      driver_tokens: {
        Row: {
          created_at: string
          driver_id: string
          expires_at: string
          id: string
          scoped_to: Database["public"]["Enums"]["token_scope"]
          token: string
          used_at: string | null
        }
        Insert: {
          created_at?: string
          driver_id: string
          expires_at: string
          id: string
          scoped_to: Database["public"]["Enums"]["token_scope"]
          token: string
          used_at?: string | null
        }
        Update: {
          created_at?: string
          driver_id?: string
          expires_at?: string
          id?: string
          scoped_to?: Database["public"]["Enums"]["token_scope"]
          token?: string
          used_at?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "driver_tokens_driver_id_fkey"
            columns: ["driver_id"]
            isOneToOne: false
            referencedRelation: "drivers"
            referencedColumns: ["id"]
          },
        ]
      }
      drivers: {
        Row: {
          current_token_id: string | null
          id: string
          initials: string
          license_expiry: string
          license_number: string
          vehicle_assignment_id: string | null
        }
        Insert: {
          current_token_id?: string | null
          id: string
          initials?: string
          license_expiry: string
          license_number: string
          vehicle_assignment_id?: string | null
        }
        Update: {
          current_token_id?: string | null
          id?: string
          initials?: string
          license_expiry?: string
          license_number?: string
          vehicle_assignment_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "drivers_id_fkey"
            columns: ["id"]
            isOneToOne: true
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "drivers_vehicle_assignment_fk"
            columns: ["vehicle_assignment_id"]
            isOneToOne: false
            referencedRelation: "vehicles"
            referencedColumns: ["id"]
          },
        ]
      }
      error_log: {
        Row: {
          context: Json
          created_at: string
          error_code: string
          function_name: string | null
          id: string
          message: string
          resolution_notes: string | null
          resolved_at: string | null
          resolved_by: string | null
          session_id: string | null
          severity: string
          source: string
          stack: string | null
          url: string | null
          user_agent: string | null
          user_id: string | null
        }
        Insert: {
          context?: Json
          created_at?: string
          error_code: string
          function_name?: string | null
          id?: string
          message: string
          resolution_notes?: string | null
          resolved_at?: string | null
          resolved_by?: string | null
          session_id?: string | null
          severity?: string
          source: string
          stack?: string | null
          url?: string | null
          user_agent?: string | null
          user_id?: string | null
        }
        Update: {
          context?: Json
          created_at?: string
          error_code?: string
          function_name?: string | null
          id?: string
          message?: string
          resolution_notes?: string | null
          resolved_at?: string | null
          resolved_by?: string | null
          session_id?: string | null
          severity?: string
          source?: string
          stack?: string | null
          url?: string | null
          user_agent?: string | null
          user_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "error_log_resolved_by_fkey"
            columns: ["resolved_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "error_log_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      fleetio_imports: {
        Row: {
          completed_at: string | null
          error_count: number
          id: string
          imported_count: number
          kind: string
          last_error: string | null
          skipped_count: number
          started_at: string
          started_by: string | null
        }
        Insert: {
          completed_at?: string | null
          error_count?: number
          id?: string
          imported_count?: number
          kind: string
          last_error?: string | null
          skipped_count?: number
          started_at?: string
          started_by?: string | null
        }
        Update: {
          completed_at?: string | null
          error_count?: number
          id?: string
          imported_count?: number
          kind?: string
          last_error?: string | null
          skipped_count?: number
          started_at?: string
          started_by?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "fleetio_imports_started_by_fkey"
            columns: ["started_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      fuel_logs: {
        Row: {
          cost: number
          created_at: string
          date: string
          driver_id: string | null
          gallons: number
          id: string
          location: string
          vehicle_id: string
        }
        Insert: {
          cost: number
          created_at?: string
          date: string
          driver_id?: string | null
          gallons: number
          id: string
          location: string
          vehicle_id: string
        }
        Update: {
          cost?: number
          created_at?: string
          date?: string
          driver_id?: string | null
          gallons?: number
          id?: string
          location?: string
          vehicle_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "fuel_logs_driver_id_fkey"
            columns: ["driver_id"]
            isOneToOne: false
            referencedRelation: "drivers"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "fuel_logs_vehicle_id_fkey"
            columns: ["vehicle_id"]
            isOneToOne: false
            referencedRelation: "vehicles"
            referencedColumns: ["id"]
          },
        ]
      }
      inspection_items: {
        Row: {
          id: string
          inspection_id: string
          name: string
          notes: string
          status: Database["public"]["Enums"]["inspection_item_status"]
        }
        Insert: {
          id?: string
          inspection_id: string
          name: string
          notes?: string
          status: Database["public"]["Enums"]["inspection_item_status"]
        }
        Update: {
          id?: string
          inspection_id?: string
          name?: string
          notes?: string
          status?: Database["public"]["Enums"]["inspection_item_status"]
        }
        Relationships: [
          {
            foreignKeyName: "inspection_items_inspection_id_fkey"
            columns: ["inspection_id"]
            isOneToOne: false
            referencedRelation: "vehicle_inspections"
            referencedColumns: ["id"]
          },
        ]
      }
      integration_alerts: {
        Row: {
          context: Json
          created_at: string
          id: string
          kind: string
          message: string
          resolved_at: string | null
        }
        Insert: {
          context?: Json
          created_at?: string
          id?: string
          kind: string
          message: string
          resolved_at?: string | null
        }
        Update: {
          context?: Json
          created_at?: string
          id?: string
          kind?: string
          message?: string
          resolved_at?: string | null
        }
        Relationships: []
      }
      inventory_items: {
        Row: {
          id: string
          last_restocked: string | null
          last_updated_at: string
          name: string
          qty_on_hand: number
          qty_reserved: number
          reorder_point: number
          sku: string
          supplier_id: string | null
        }
        Insert: {
          id: string
          last_restocked?: string | null
          last_updated_at?: string
          name: string
          qty_on_hand?: number
          qty_reserved?: number
          reorder_point?: number
          sku: string
          supplier_id?: string | null
        }
        Update: {
          id?: string
          last_restocked?: string | null
          last_updated_at?: string
          name?: string
          qty_on_hand?: number
          qty_reserved?: number
          reorder_point?: number
          sku?: string
          supplier_id?: string | null
        }
        Relationships: []
      }
      invoice_data: {
        Row: {
          client_id: string
          created_at: string
          id: string
          kind: Database["public"]["Enums"]["invoice_kind"]
          qbo_invoice_id: string | null
          qbo_sync_status: Database["public"]["Enums"]["qbo_sync_status"]
          total: number
          work_order_id: string | null
        }
        Insert: {
          client_id: string
          created_at?: string
          id: string
          kind?: Database["public"]["Enums"]["invoice_kind"]
          qbo_invoice_id?: string | null
          qbo_sync_status?: Database["public"]["Enums"]["qbo_sync_status"]
          total?: number
          work_order_id?: string | null
        }
        Update: {
          client_id?: string
          created_at?: string
          id?: string
          kind?: Database["public"]["Enums"]["invoice_kind"]
          qbo_invoice_id?: string | null
          qbo_sync_status?: Database["public"]["Enums"]["qbo_sync_status"]
          total?: number
          work_order_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "invoice_data_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "clients"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "invoice_data_work_order_id_fkey"
            columns: ["work_order_id"]
            isOneToOne: false
            referencedRelation: "work_orders"
            referencedColumns: ["id"]
          },
        ]
      }
      invoice_line_items: {
        Row: {
          amount: number
          description: string
          id: string
          invoice_data_id: string
          position: number
          qty: number
          rate: number
        }
        Insert: {
          amount: number
          description: string
          id?: string
          invoice_data_id: string
          position?: number
          qty: number
          rate: number
        }
        Update: {
          amount?: number
          description?: string
          id?: string
          invoice_data_id?: string
          position?: number
          qty?: number
          rate?: number
        }
        Relationships: [
          {
            foreignKeyName: "invoice_line_items_invoice_data_id_fkey"
            columns: ["invoice_data_id"]
            isOneToOne: false
            referencedRelation: "invoice_data"
            referencedColumns: ["id"]
          },
        ]
      }
      job_logs: {
        Row: {
          body: string
          created_at: string
          driver_id: string
          gps_lat: number | null
          gps_lng: number | null
          id: string
          idempotency_key: string | null
          job_id: string
          logged_at: string
          vehicle_id: string | null
        }
        Insert: {
          body: string
          created_at?: string
          driver_id: string
          gps_lat?: number | null
          gps_lng?: number | null
          id: string
          idempotency_key?: string | null
          job_id: string
          logged_at?: string
          vehicle_id?: string | null
        }
        Update: {
          body?: string
          created_at?: string
          driver_id?: string
          gps_lat?: number | null
          gps_lng?: number | null
          id?: string
          idempotency_key?: string | null
          job_id?: string
          logged_at?: string
          vehicle_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "job_logs_driver_id_fkey"
            columns: ["driver_id"]
            isOneToOne: false
            referencedRelation: "drivers"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "job_logs_job_id_fkey"
            columns: ["job_id"]
            isOneToOne: false
            referencedRelation: "jobs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "job_logs_vehicle_id_fkey"
            columns: ["vehicle_id"]
            isOneToOne: false
            referencedRelation: "vehicles"
            referencedColumns: ["id"]
          },
        ]
      }
      jobs: {
        Row: {
          client_id: string
          created_at: string
          created_by: string | null
          driver_id: string | null
          duration_min: number
          id: string
          location_address: string
          location_lat: number | null
          location_lng: number | null
          notes: string
          scheduled_at: string
          status: Database["public"]["Enums"]["job_status"]
          vehicle_id: string | null
        }
        Insert: {
          client_id: string
          created_at?: string
          created_by?: string | null
          driver_id?: string | null
          duration_min?: number
          id: string
          location_address: string
          location_lat?: number | null
          location_lng?: number | null
          notes?: string
          scheduled_at: string
          status?: Database["public"]["Enums"]["job_status"]
          vehicle_id?: string | null
        }
        Update: {
          client_id?: string
          created_at?: string
          created_by?: string | null
          driver_id?: string | null
          duration_min?: number
          id?: string
          location_address?: string
          location_lat?: number | null
          location_lng?: number | null
          notes?: string
          scheduled_at?: string
          status?: Database["public"]["Enums"]["job_status"]
          vehicle_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "jobs_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "clients"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "jobs_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "jobs_driver_id_fkey"
            columns: ["driver_id"]
            isOneToOne: false
            referencedRelation: "drivers"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "jobs_vehicle_id_fkey"
            columns: ["vehicle_id"]
            isOneToOne: false
            referencedRelation: "vehicles"
            referencedColumns: ["id"]
          },
        ]
      }
      maintenance_logs: {
        Row: {
          attachments: string[]
          cost: number
          created_at: string
          date: string
          id: string
          mileage: number
          notes: string
          performed_by: string
          type: string
          vehicle_id: string
        }
        Insert: {
          attachments?: string[]
          cost?: number
          created_at?: string
          date: string
          id: string
          mileage?: number
          notes?: string
          performed_by: string
          type: string
          vehicle_id: string
        }
        Update: {
          attachments?: string[]
          cost?: number
          created_at?: string
          date?: string
          id?: string
          mileage?: number
          notes?: string
          performed_by?: string
          type?: string
          vehicle_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "maintenance_logs_vehicle_id_fkey"
            columns: ["vehicle_id"]
            isOneToOne: false
            referencedRelation: "vehicles"
            referencedColumns: ["id"]
          },
        ]
      }
      maintenance_work_orders: {
        Row: {
          assigned_mechanic_id: string | null
          claimed_at: string | null
          completed_at: string | null
          completion_notes: string | null
          created_at: string
          final_cost: number | null
          id: string
          idempotency_key: string | null
          issue_description: string
          labor_hours: number
          labor_notes: string
          parts_used: Json
          priority: string
          reported_by: string | null
          reported_from: string
          source_inspection_id: string | null
          started_at: string | null
          status: string
          updated_at: string
          vehicle_id: string
        }
        Insert: {
          assigned_mechanic_id?: string | null
          claimed_at?: string | null
          completed_at?: string | null
          completion_notes?: string | null
          created_at?: string
          final_cost?: number | null
          id: string
          idempotency_key?: string | null
          issue_description: string
          labor_hours?: number
          labor_notes?: string
          parts_used?: Json
          priority?: string
          reported_by?: string | null
          reported_from: string
          source_inspection_id?: string | null
          started_at?: string | null
          status?: string
          updated_at?: string
          vehicle_id: string
        }
        Update: {
          assigned_mechanic_id?: string | null
          claimed_at?: string | null
          completed_at?: string | null
          completion_notes?: string | null
          created_at?: string
          final_cost?: number | null
          id?: string
          idempotency_key?: string | null
          issue_description?: string
          labor_hours?: number
          labor_notes?: string
          parts_used?: Json
          priority?: string
          reported_by?: string | null
          reported_from?: string
          source_inspection_id?: string | null
          started_at?: string | null
          status?: string
          updated_at?: string
          vehicle_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "maintenance_work_orders_assigned_mechanic_id_fkey"
            columns: ["assigned_mechanic_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "maintenance_work_orders_reported_by_fkey"
            columns: ["reported_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "maintenance_work_orders_source_inspection_id_fkey"
            columns: ["source_inspection_id"]
            isOneToOne: false
            referencedRelation: "vehicle_inspections"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "maintenance_work_orders_vehicle_id_fkey"
            columns: ["vehicle_id"]
            isOneToOne: false
            referencedRelation: "vehicles"
            referencedColumns: ["id"]
          },
        ]
      }
      mechanics: {
        Row: {
          id: string
          shop_id: string
          specialty: string
        }
        Insert: {
          id: string
          shop_id?: string
          specialty?: string
        }
        Update: {
          id?: string
          shop_id?: string
          specialty?: string
        }
        Relationships: [
          {
            foreignKeyName: "mechanics_id_fkey"
            columns: ["id"]
            isOneToOne: true
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      notifications: {
        Row: {
          body: string
          created_at: string
          id: string
          link: string | null
          read_at: string | null
          type: Database["public"]["Enums"]["notification_type"]
          user_id: string
        }
        Insert: {
          body: string
          created_at?: string
          id: string
          link?: string | null
          read_at?: string | null
          type: Database["public"]["Enums"]["notification_type"]
          user_id: string
        }
        Update: {
          body?: string
          created_at?: string
          id?: string
          link?: string | null
          read_at?: string | null
          type?: Database["public"]["Enums"]["notification_type"]
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "notifications_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      profiles: {
        Row: {
          created_at: string
          email: string
          id: string
          name: string
          phone: string
          role: Database["public"]["Enums"]["user_role"]
          status: Database["public"]["Enums"]["user_status"]
        }
        Insert: {
          created_at?: string
          email: string
          id: string
          name: string
          phone?: string
          role: Database["public"]["Enums"]["user_role"]
          status?: Database["public"]["Enums"]["user_status"]
        }
        Update: {
          created_at?: string
          email?: string
          id?: string
          name?: string
          phone?: string
          role?: Database["public"]["Enums"]["user_role"]
          status?: Database["public"]["Enums"]["user_status"]
        }
        Relationships: []
      }
      purchase_requests: {
        Row: {
          approved_by: string | null
          created_at: string
          estimated_cost: number
          id: string
          idempotency_key: string | null
          inventory_check_result: Json | null
          inventory_checked_at: string | null
          inventory_decrement_qty: number | null
          item: string
          mechanic_id: string
          ordered_at: string | null
          ordered_by: string | null
          reason: string
          status: Database["public"]["Enums"]["purchase_request_status"]
          supplier_id: string | null
          supplier_order_ref: string | null
          urgency: Database["public"]["Enums"]["urgency_level"]
          vehicle_id: string | null
        }
        Insert: {
          approved_by?: string | null
          created_at?: string
          estimated_cost?: number
          id: string
          idempotency_key?: string | null
          inventory_check_result?: Json | null
          inventory_checked_at?: string | null
          inventory_decrement_qty?: number | null
          item: string
          mechanic_id: string
          ordered_at?: string | null
          ordered_by?: string | null
          reason: string
          status?: Database["public"]["Enums"]["purchase_request_status"]
          supplier_id?: string | null
          supplier_order_ref?: string | null
          urgency?: Database["public"]["Enums"]["urgency_level"]
          vehicle_id?: string | null
        }
        Update: {
          approved_by?: string | null
          created_at?: string
          estimated_cost?: number
          id?: string
          idempotency_key?: string | null
          inventory_check_result?: Json | null
          inventory_checked_at?: string | null
          inventory_decrement_qty?: number | null
          item?: string
          mechanic_id?: string
          ordered_at?: string | null
          ordered_by?: string | null
          reason?: string
          status?: Database["public"]["Enums"]["purchase_request_status"]
          supplier_id?: string | null
          supplier_order_ref?: string | null
          urgency?: Database["public"]["Enums"]["urgency_level"]
          vehicle_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "purchase_requests_approved_by_fkey"
            columns: ["approved_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "purchase_requests_mechanic_id_fkey"
            columns: ["mechanic_id"]
            isOneToOne: false
            referencedRelation: "mechanics"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "purchase_requests_ordered_by_fkey"
            columns: ["ordered_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "purchase_requests_vehicle_id_fkey"
            columns: ["vehicle_id"]
            isOneToOne: false
            referencedRelation: "vehicles"
            referencedColumns: ["id"]
          },
        ]
      }
      qbo_employee_mappings: {
        Row: {
          driver_id: string
          mapped_at: string
          mapped_by: string | null
          qbo_employee_id: string
        }
        Insert: {
          driver_id: string
          mapped_at?: string
          mapped_by?: string | null
          qbo_employee_id: string
        }
        Update: {
          driver_id?: string
          mapped_at?: string
          mapped_by?: string | null
          qbo_employee_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "qbo_employee_mappings_driver_id_fkey"
            columns: ["driver_id"]
            isOneToOne: true
            referencedRelation: "drivers"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "qbo_employee_mappings_mapped_by_fkey"
            columns: ["mapped_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      qbo_oauth_tokens: {
        Row: {
          access_token: string | null
          access_token_expires_at: string | null
          created_at: string
          id: string
          refresh_token: string
          updated_at: string
        }
        Insert: {
          access_token?: string | null
          access_token_expires_at?: string | null
          created_at?: string
          id?: string
          refresh_token: string
          updated_at?: string
        }
        Update: {
          access_token?: string | null
          access_token_expires_at?: string | null
          created_at?: string
          id?: string
          refresh_token?: string
          updated_at?: string
        }
        Relationships: []
      }
      qbo_payroll_pushes: {
        Row: {
          created_at: string
          driver_id: string | null
          error_message: string | null
          hours: number
          id: string
          period_end: string
          period_start: string
          pushed_at: string | null
          qbo_time_activity_id: string | null
          status: string
          time_entry_id: string | null
        }
        Insert: {
          created_at?: string
          driver_id?: string | null
          error_message?: string | null
          hours: number
          id?: string
          period_end: string
          period_start: string
          pushed_at?: string | null
          qbo_time_activity_id?: string | null
          status: string
          time_entry_id?: string | null
        }
        Update: {
          created_at?: string
          driver_id?: string | null
          error_message?: string | null
          hours?: number
          id?: string
          period_end?: string
          period_start?: string
          pushed_at?: string | null
          qbo_time_activity_id?: string | null
          status?: string
          time_entry_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "qbo_payroll_pushes_driver_id_fkey"
            columns: ["driver_id"]
            isOneToOne: false
            referencedRelation: "drivers"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "qbo_payroll_pushes_time_entry_id_fkey"
            columns: ["time_entry_id"]
            isOneToOne: false
            referencedRelation: "time_entries"
            referencedColumns: ["id"]
          },
        ]
      }
      rate_line_items: {
        Row: {
          description: string
          id: string
          position: number
          rate: number
          rate_table_id: string
          surcharges: Json
          unit: string
        }
        Insert: {
          description: string
          id?: string
          position?: number
          rate: number
          rate_table_id: string
          surcharges?: Json
          unit: string
        }
        Update: {
          description?: string
          id?: string
          position?: number
          rate?: number
          rate_table_id?: string
          surcharges?: Json
          unit?: string
        }
        Relationships: [
          {
            foreignKeyName: "rate_line_items_rate_table_id_fkey"
            columns: ["rate_table_id"]
            isOneToOne: false
            referencedRelation: "rate_tables"
            referencedColumns: ["id"]
          },
        ]
      }
      rate_tables: {
        Row: {
          client_id: string
          created_at: string
          id: string
        }
        Insert: {
          client_id: string
          created_at?: string
          id: string
        }
        Update: {
          client_id?: string
          created_at?: string
          id?: string
        }
        Relationships: [
          {
            foreignKeyName: "rate_tables_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "clients"
            referencedColumns: ["id"]
          },
        ]
      }
      sms_logs: {
        Row: {
          body: string
          delivery_status: Database["public"]["Enums"]["sms_delivery_status"]
          driver_id: string | null
          id: string
          job_id: string | null
          sent_at: string
          twilio_message_id: string | null
        }
        Insert: {
          body: string
          delivery_status?: Database["public"]["Enums"]["sms_delivery_status"]
          driver_id?: string | null
          id: string
          job_id?: string | null
          sent_at?: string
          twilio_message_id?: string | null
        }
        Update: {
          body?: string
          delivery_status?: Database["public"]["Enums"]["sms_delivery_status"]
          driver_id?: string | null
          id?: string
          job_id?: string | null
          sent_at?: string
          twilio_message_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "sms_logs_driver_id_fkey"
            columns: ["driver_id"]
            isOneToOne: false
            referencedRelation: "drivers"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "sms_logs_job_id_fkey"
            columns: ["job_id"]
            isOneToOne: false
            referencedRelation: "jobs"
            referencedColumns: ["id"]
          },
        ]
      }
      tender_digests: {
        Row: {
          content: Json
          generated_at: string
          id: string
          sent_at: string | null
          sent_to: string[] | null
          tender_count: number
          week_end_date: string
          week_start_date: string
        }
        Insert: {
          content?: Json
          generated_at?: string
          id?: string
          sent_at?: string | null
          sent_to?: string[] | null
          tender_count?: number
          week_end_date: string
          week_start_date: string
        }
        Update: {
          content?: Json
          generated_at?: string
          id?: string
          sent_at?: string | null
          sent_to?: string[] | null
          tender_count?: number
          week_end_date?: string
          week_start_date?: string
        }
        Relationships: []
      }
      tender_sources: {
        Row: {
          base_url: string
          created_at: string
          enabled: boolean
          id: string
          last_error: string | null
          last_run_at: string | null
          name: string
          notes: string | null
        }
        Insert: {
          base_url: string
          created_at?: string
          enabled?: boolean
          id: string
          last_error?: string | null
          last_run_at?: string | null
          name: string
          notes?: string | null
        }
        Update: {
          base_url?: string
          created_at?: string
          enabled?: boolean
          id?: string
          last_error?: string | null
          last_run_at?: string | null
          name?: string
          notes?: string | null
        }
        Relationships: []
      }
      tenders: {
        Row: {
          closing_date: string | null
          id: string
          scraped_at: string
          source: string
          summary: string
          title: string
          url: string
        }
        Insert: {
          closing_date?: string | null
          id: string
          scraped_at?: string
          source: string
          summary?: string
          title: string
          url: string
        }
        Update: {
          closing_date?: string | null
          id?: string
          scraped_at?: string
          source?: string
          summary?: string
          title?: string
          url?: string
        }
        Relationships: []
      }
      ticket_photos: {
        Row: {
          driver_id: string
          entered_by: string | null
          id: string
          idempotency_key: string | null
          job_id: string
          location: string | null
          photo_url: string
          status: Database["public"]["Enums"]["ticket_photo_status"]
          uploaded_at: string
          weight: number | null
        }
        Insert: {
          driver_id: string
          entered_by?: string | null
          id: string
          idempotency_key?: string | null
          job_id: string
          location?: string | null
          photo_url: string
          status?: Database["public"]["Enums"]["ticket_photo_status"]
          uploaded_at?: string
          weight?: number | null
        }
        Update: {
          driver_id?: string
          entered_by?: string | null
          id?: string
          idempotency_key?: string | null
          job_id?: string
          location?: string | null
          photo_url?: string
          status?: Database["public"]["Enums"]["ticket_photo_status"]
          uploaded_at?: string
          weight?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "ticket_photos_driver_id_fkey"
            columns: ["driver_id"]
            isOneToOne: false
            referencedRelation: "drivers"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "ticket_photos_entered_by_fkey"
            columns: ["entered_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "ticket_photos_job_id_fkey"
            columns: ["job_id"]
            isOneToOne: false
            referencedRelation: "jobs"
            referencedColumns: ["id"]
          },
        ]
      }
      ticket_replenishments: {
        Row: {
          amount: number
          auto_billed: boolean
          client_id: string
          id: string
          invoice_data_id: string
          qbo_invoice_id: string | null
          qbo_sync_status: Database["public"]["Enums"]["qbo_sync_status"]
          qty: number
          triggered_at: string
        }
        Insert: {
          amount: number
          auto_billed?: boolean
          client_id: string
          id: string
          invoice_data_id: string
          qbo_invoice_id?: string | null
          qbo_sync_status?: Database["public"]["Enums"]["qbo_sync_status"]
          qty: number
          triggered_at?: string
        }
        Update: {
          amount?: number
          auto_billed?: boolean
          client_id?: string
          id?: string
          invoice_data_id?: string
          qbo_invoice_id?: string | null
          qbo_sync_status?: Database["public"]["Enums"]["qbo_sync_status"]
          qty?: number
          triggered_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "ticket_replenishments_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "clients"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "ticket_replenishments_invoice_data_id_fkey"
            columns: ["invoice_data_id"]
            isOneToOne: false
            referencedRelation: "invoice_data"
            referencedColumns: ["id"]
          },
        ]
      }
      ticket_transactions: {
        Row: {
          balance_after: number
          client_id: string
          dump_site: string | null
          id: string
          kind: Database["public"]["Enums"]["ticket_txn_kind"]
          occurred_at: string
          qty: number
          reason: string
          vehicle_id: string | null
          work_order_id: string | null
        }
        Insert: {
          balance_after: number
          client_id: string
          dump_site?: string | null
          id: string
          kind: Database["public"]["Enums"]["ticket_txn_kind"]
          occurred_at?: string
          qty: number
          reason?: string
          vehicle_id?: string | null
          work_order_id?: string | null
        }
        Update: {
          balance_after?: number
          client_id?: string
          dump_site?: string | null
          id?: string
          kind?: Database["public"]["Enums"]["ticket_txn_kind"]
          occurred_at?: string
          qty?: number
          reason?: string
          vehicle_id?: string | null
          work_order_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "ticket_transactions_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "clients"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "ticket_transactions_vehicle_id_fkey"
            columns: ["vehicle_id"]
            isOneToOne: false
            referencedRelation: "vehicles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "ticket_transactions_work_order_id_fkey"
            columns: ["work_order_id"]
            isOneToOne: false
            referencedRelation: "work_orders"
            referencedColumns: ["id"]
          },
        ]
      }
      time_entries: {
        Row: {
          clock_in: string
          clock_out: string | null
          driver_id: string
          flag_reason: string
          flag_tolerance_minutes: number | null
          flagged: boolean
          gps_clock_in_lat: number | null
          gps_clock_in_lng: number | null
          gps_clock_out_lat: number | null
          gps_clock_out_lng: number | null
          id: string
          pretrip_inspection_id: string | null
          vehicle_movement_correlation: Database["public"]["Enums"]["movement_correlation"]
        }
        Insert: {
          clock_in: string
          clock_out?: string | null
          driver_id: string
          flag_reason?: string
          flag_tolerance_minutes?: number | null
          flagged?: boolean
          gps_clock_in_lat?: number | null
          gps_clock_in_lng?: number | null
          gps_clock_out_lat?: number | null
          gps_clock_out_lng?: number | null
          id: string
          pretrip_inspection_id?: string | null
          vehicle_movement_correlation?: Database["public"]["Enums"]["movement_correlation"]
        }
        Update: {
          clock_in?: string
          clock_out?: string | null
          driver_id?: string
          flag_reason?: string
          flag_tolerance_minutes?: number | null
          flagged?: boolean
          gps_clock_in_lat?: number | null
          gps_clock_in_lng?: number | null
          gps_clock_out_lat?: number | null
          gps_clock_out_lng?: number | null
          id?: string
          pretrip_inspection_id?: string | null
          vehicle_movement_correlation?: Database["public"]["Enums"]["movement_correlation"]
        }
        Relationships: [
          {
            foreignKeyName: "time_entries_driver_id_fkey"
            columns: ["driver_id"]
            isOneToOne: false
            referencedRelation: "drivers"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "time_entries_pretrip_inspection_id_fkey"
            columns: ["pretrip_inspection_id"]
            isOneToOne: false
            referencedRelation: "vehicle_inspections"
            referencedColumns: ["id"]
          },
        ]
      }
      tool_checklist_items: {
        Row: {
          id: string
          notes: string
          status: Database["public"]["Enums"]["tool_condition"]
          submission_id: string
          tool_id: string
        }
        Insert: {
          id?: string
          notes?: string
          status: Database["public"]["Enums"]["tool_condition"]
          submission_id: string
          tool_id: string
        }
        Update: {
          id?: string
          notes?: string
          status?: Database["public"]["Enums"]["tool_condition"]
          submission_id?: string
          tool_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "tool_checklist_items_submission_id_fkey"
            columns: ["submission_id"]
            isOneToOne: false
            referencedRelation: "tool_checklist_submissions"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "tool_checklist_items_tool_id_fkey"
            columns: ["tool_id"]
            isOneToOne: false
            referencedRelation: "tools"
            referencedColumns: ["id"]
          },
        ]
      }
      tool_checklist_submissions: {
        Row: {
          driver_id: string
          gps_lat: number | null
          gps_lng: number | null
          id: string
          idempotency_key: string | null
          kind: string
          submitted_at: string
          vehicle_id: string
        }
        Insert: {
          driver_id: string
          gps_lat?: number | null
          gps_lng?: number | null
          id: string
          idempotency_key?: string | null
          kind?: string
          submitted_at?: string
          vehicle_id: string
        }
        Update: {
          driver_id?: string
          gps_lat?: number | null
          gps_lng?: number | null
          id?: string
          idempotency_key?: string | null
          kind?: string
          submitted_at?: string
          vehicle_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "tool_checklist_submissions_driver_id_fkey"
            columns: ["driver_id"]
            isOneToOne: false
            referencedRelation: "drivers"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "tool_checklist_submissions_vehicle_id_fkey"
            columns: ["vehicle_id"]
            isOneToOne: false
            referencedRelation: "vehicles"
            referencedColumns: ["id"]
          },
        ]
      }
      tools: {
        Row: {
          condition: Database["public"]["Enums"]["tool_condition"]
          created_at: string
          id: string
          name: string
          vehicle_id: string | null
        }
        Insert: {
          condition?: Database["public"]["Enums"]["tool_condition"]
          created_at?: string
          id: string
          name: string
          vehicle_id?: string | null
        }
        Update: {
          condition?: Database["public"]["Enums"]["tool_condition"]
          created_at?: string
          id?: string
          name?: string
          vehicle_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "tools_vehicle_id_fkey"
            columns: ["vehicle_id"]
            isOneToOne: false
            referencedRelation: "vehicles"
            referencedColumns: ["id"]
          },
        ]
      }
      vehicle_inspections: {
        Row: {
          driver_id: string
          flagged: boolean
          geotab_captured_at: string | null
          geotab_distance_meters: number | null
          geotab_lat: number | null
          geotab_lng: number | null
          gps_captured_at: string | null
          gps_lat: number | null
          gps_lng: number | null
          id: string
          idempotency_key: string | null
          notes: string
          photos: string[]
          submitted_at: string
          vehicle_id: string
        }
        Insert: {
          driver_id: string
          flagged?: boolean
          geotab_captured_at?: string | null
          geotab_distance_meters?: number | null
          geotab_lat?: number | null
          geotab_lng?: number | null
          gps_captured_at?: string | null
          gps_lat?: number | null
          gps_lng?: number | null
          id: string
          idempotency_key?: string | null
          notes?: string
          photos?: string[]
          submitted_at?: string
          vehicle_id: string
        }
        Update: {
          driver_id?: string
          flagged?: boolean
          geotab_captured_at?: string | null
          geotab_distance_meters?: number | null
          geotab_lat?: number | null
          geotab_lng?: number | null
          gps_captured_at?: string | null
          gps_lat?: number | null
          gps_lng?: number | null
          id?: string
          idempotency_key?: string | null
          notes?: string
          photos?: string[]
          submitted_at?: string
          vehicle_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "vehicle_inspections_driver_id_fkey"
            columns: ["driver_id"]
            isOneToOne: false
            referencedRelation: "drivers"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "vehicle_inspections_vehicle_id_fkey"
            columns: ["vehicle_id"]
            isOneToOne: false
            referencedRelation: "vehicles"
            referencedColumns: ["id"]
          },
        ]
      }
      vehicle_locations: {
        Row: {
          bearing: number | null
          geotab_device_id: string | null
          id: string
          is_driving: boolean | null
          latitude: number
          longitude: number
          recorded_at: string
          speed_kmh: number | null
          vehicle_id: string
        }
        Insert: {
          bearing?: number | null
          geotab_device_id?: string | null
          id?: string
          is_driving?: boolean | null
          latitude: number
          longitude: number
          recorded_at: string
          speed_kmh?: number | null
          vehicle_id: string
        }
        Update: {
          bearing?: number | null
          geotab_device_id?: string | null
          id?: string
          is_driving?: boolean | null
          latitude?: number
          longitude?: number
          recorded_at?: string
          speed_kmh?: number | null
          vehicle_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "vehicle_locations_vehicle_id_fkey"
            columns: ["vehicle_id"]
            isOneToOne: false
            referencedRelation: "vehicles"
            referencedColumns: ["id"]
          },
        ]
      }
      vehicles: {
        Row: {
          bearing: number | null
          created_at: string
          driver_id: string | null
          engine_hours: number
          geotab_device_id: string | null
          id: string
          is_device_communicating: boolean | null
          is_driving: boolean | null
          last_pretrip_at: string | null
          last_seen_at: string | null
          last_service: string | null
          latitude: number | null
          location_updated_at: string | null
          longitude: number | null
          name: string
          next_service_due: string | null
          odometer: number
          plate: string
          speed_kmh: number | null
          speed_mph: number | null
          status: Database["public"]["Enums"]["vehicle_status"]
          type: Database["public"]["Enums"]["vehicle_type"]
          vin: string
          year: number
        }
        Insert: {
          bearing?: number | null
          created_at?: string
          driver_id?: string | null
          engine_hours?: number
          geotab_device_id?: string | null
          id: string
          is_device_communicating?: boolean | null
          is_driving?: boolean | null
          last_pretrip_at?: string | null
          last_seen_at?: string | null
          last_service?: string | null
          latitude?: number | null
          location_updated_at?: string | null
          longitude?: number | null
          name: string
          next_service_due?: string | null
          odometer?: number
          plate: string
          speed_kmh?: number | null
          speed_mph?: number | null
          status?: Database["public"]["Enums"]["vehicle_status"]
          type: Database["public"]["Enums"]["vehicle_type"]
          vin: string
          year: number
        }
        Update: {
          bearing?: number | null
          created_at?: string
          driver_id?: string | null
          engine_hours?: number
          geotab_device_id?: string | null
          id?: string
          is_device_communicating?: boolean | null
          is_driving?: boolean | null
          last_pretrip_at?: string | null
          last_seen_at?: string | null
          last_service?: string | null
          latitude?: number | null
          location_updated_at?: string | null
          longitude?: number | null
          name?: string
          next_service_due?: string | null
          odometer?: number
          plate?: string
          speed_kmh?: number | null
          speed_mph?: number | null
          status?: Database["public"]["Enums"]["vehicle_status"]
          type?: Database["public"]["Enums"]["vehicle_type"]
          vin?: string
          year?: number
        }
        Relationships: [
          {
            foreignKeyName: "vehicles_driver_id_fkey"
            columns: ["driver_id"]
            isOneToOne: false
            referencedRelation: "drivers"
            referencedColumns: ["id"]
          },
        ]
      }
      work_orders: {
        Row: {
          approved_at: string | null
          approved_by: string | null
          driver_id: string
          dump_site: string
          foreman_signature: string
          gps_captured_at: string | null
          gps_lat: number | null
          gps_lng: number | null
          id: string
          idempotency_key: string | null
          invoice_data_id: string | null
          job_id: string
          load_type: string
          site_issues: boolean
          site_issues_note: string
          status: Database["public"]["Enums"]["work_order_status"]
          submitted_at: string
          weight_tonnes: number
          work_performed: string
        }
        Insert: {
          approved_at?: string | null
          approved_by?: string | null
          driver_id: string
          dump_site?: string
          foreman_signature?: string
          gps_captured_at?: string | null
          gps_lat?: number | null
          gps_lng?: number | null
          id: string
          idempotency_key?: string | null
          invoice_data_id?: string | null
          job_id: string
          load_type?: string
          site_issues?: boolean
          site_issues_note?: string
          status?: Database["public"]["Enums"]["work_order_status"]
          submitted_at?: string
          weight_tonnes?: number
          work_performed?: string
        }
        Update: {
          approved_at?: string | null
          approved_by?: string | null
          driver_id?: string
          dump_site?: string
          foreman_signature?: string
          gps_captured_at?: string | null
          gps_lat?: number | null
          gps_lng?: number | null
          id?: string
          idempotency_key?: string | null
          invoice_data_id?: string | null
          job_id?: string
          load_type?: string
          site_issues?: boolean
          site_issues_note?: string
          status?: Database["public"]["Enums"]["work_order_status"]
          submitted_at?: string
          weight_tonnes?: number
          work_performed?: string
        }
        Relationships: [
          {
            foreignKeyName: "work_orders_approved_by_fkey"
            columns: ["approved_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "work_orders_driver_id_fkey"
            columns: ["driver_id"]
            isOneToOne: false
            referencedRelation: "drivers"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "work_orders_invoice_fk"
            columns: ["invoice_data_id"]
            isOneToOne: false
            referencedRelation: "invoice_data"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "work_orders_job_id_fkey"
            columns: ["job_id"]
            isOneToOne: false
            referencedRelation: "jobs"
            referencedColumns: ["id"]
          },
        ]
      }
    }
    Views: {
      unresolved_errors: {
        Row: {
          context: Json | null
          created_at: string | null
          error_code: string | null
          function_name: string | null
          id: string | null
          message: string | null
          resolution_notes: string | null
          resolved_at: string | null
          resolved_by: string | null
          session_id: string | null
          severity: string | null
          source: string | null
          stack: string | null
          url: string | null
          user_agent: string | null
          user_id: string | null
        }
        Insert: {
          context?: Json | null
          created_at?: string | null
          error_code?: string | null
          function_name?: string | null
          id?: string | null
          message?: string | null
          resolution_notes?: string | null
          resolved_at?: string | null
          resolved_by?: string | null
          session_id?: string | null
          severity?: string | null
          source?: string | null
          stack?: string | null
          url?: string | null
          user_agent?: string | null
          user_id?: string | null
        }
        Update: {
          context?: Json | null
          created_at?: string | null
          error_code?: string | null
          function_name?: string | null
          id?: string | null
          message?: string | null
          resolution_notes?: string | null
          resolved_at?: string | null
          resolved_by?: string | null
          session_id?: string | null
          severity?: string | null
          source?: string | null
          stack?: string | null
          url?: string | null
          user_agent?: string | null
          user_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "error_log_resolved_by_fkey"
            columns: ["resolved_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "error_log_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
    }
    Functions: {
      approve_purchase_request: {
        Args: { p_approver_id: string; p_id: string }
        Returns: {
          inventory_decrement_qty: number
          matched_inventory_id: string
          ok: boolean
          pr_status: Database["public"]["Enums"]["purchase_request_status"]
        }[]
      }
      approve_work_order: {
        Args: {
          p_approver_id: string
          p_client_id: string
          p_invoice_id: string
          p_line_items: Json
          p_total: number
          p_wo_id: string
        }
        Returns: {
          error: string
          invoice_id: string
          ok: boolean
          wo_status: string
        }[]
      }
      bootstrap_vault_service_role_key: {
        Args: { p_key: string }
        Returns: string
      }
      claim_maintenance_work_order: {
        Args: { p_id: string; p_mechanic_id: string }
        Returns: {
          assigned_mechanic_id: string
          error: string
          ok: boolean
          status: string
        }[]
      }
      consume_driver_token: { Args: { p_token: string }; Returns: boolean }
      create_driver_token: {
        Args: { p_driver_id: string; p_hours?: number; p_scope: string }
        Returns: {
          expires_at: string
          id: string
          token: string
        }[]
      }
      current_role_value: {
        Args: never
        Returns: Database["public"]["Enums"]["user_role"]
      }
      debit_client_ticket: {
        Args: {
          p_actor_id: string
          p_client_id: string
          p_dump_site: string
          p_tickets: number
          p_vehicle_id: string
          p_work_order_id: string
        }
        Returns: {
          error: string
          new_balance: number
          ok: boolean
          transaction_id: string
        }[]
      }
      is_admin: { Args: never; Returns: boolean }
      list_cron_jobs: {
        Args: never
        Returns: {
          active: boolean
          command: string
          jobid: number
          jobname: string
          schedule: string
        }[]
      }
      lock_qbo_oauth_refresh: { Args: never; Returns: undefined }
      recent_cron_runs: {
        Args: { p_jobname?: string; p_limit?: number }
        Returns: {
          command: string
          database: string
          end_time: string
          job_pid: number
          jobid: number
          return_message: string
          runid: number
          start_time: string
          status: string
          username: string
        }[]
      }
      record_driver_ticket_use: {
        Args: {
          p_client_id: string
          p_dump_site: string
          p_reason?: string
          p_tickets: number
          p_vehicle_id: string
        }
        Returns: {
          error: string
          new_balance: number
          ok: boolean
          transaction_id: string
        }[]
      }
      release_maintenance_work_order: {
        Args: { p_id: string; p_mechanic_id: string }
        Returns: {
          error: string
          ok: boolean
          status: string
        }[]
      }
      report_error: {
        Args: {
          p_context?: Json
          p_error_code: string
          p_function_name?: string
          p_message: string
          p_session_id?: string
          p_severity?: string
          p_source: string
          p_stack?: string
          p_url?: string
          p_user_agent?: string
        }
        Returns: string
      }
      top_up_client_tickets: {
        Args: {
          p_actor_id: string
          p_amount: number
          p_auto_billed: boolean
          p_client_id: string
          p_invoice_id: string
          p_notes?: string
          p_qty: number
          p_replenish_id: string
        }
        Returns: {
          error: string
          invoice_id: string
          new_balance: number
          ok: boolean
          replenish_id: string
          transaction_id: string
        }[]
      }
      unlock_qbo_oauth_refresh: { Args: never; Returns: undefined }
      upsert_client_rate_table: {
        Args: { p_client_id: string; p_line_items: Json }
        Returns: string
      }
      validate_driver_token: {
        Args: { p_token: string }
        Returns: {
          driver_id: string
          expires_at: string
          scoped_to: Database["public"]["Enums"]["token_scope"]
          state: string
          used_at: string
        }[]
      }
    }
    Enums: {
      inspection_item_status: "ok" | "issue"
      invoice_kind: "work-order" | "ticket-replenishment"
      job_status:
        | "draft"
        | "scheduled"
        | "active"
        | "completed"
        | "delayed"
        | "cancelled"
      movement_correlation: "matches" | "mismatch" | "pending"
      notification_type: "job" | "approval" | "alert" | "system"
      purchase_request_status: "pending" | "approved" | "rejected" | "ordered"
      qbo_sync_status: "not-synced" | "pending" | "synced" | "failed"
      sms_delivery_status: "queued" | "sent" | "delivered" | "failed"
      ticket_photo_status: "awaiting-entry" | "entered"
      ticket_report_frequency: "off" | "daily" | "weekly" | "monthly"
      ticket_txn_kind: "debit" | "credit" | "adjustment"
      token_scope: "forms" | "job" | "shift" | "tickets"
      tool_condition: "ok" | "missing" | "damaged"
      urgency_level: "low" | "medium" | "high"
      user_role: "admin" | "driver" | "mechanic"
      user_status: "active" | "inactive" | "suspended"
      vehicle_status: "operational" | "maintenance" | "out-of-service"
      vehicle_type: "truck" | "trailer" | "equipment"
      work_order_status: "pending" | "approved" | "rejected"
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
}

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] &
        DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] &
        DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R
      }
      ? R
      : never
    : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I
      }
      ? I
      : never
    : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U
      }
      ? U
      : never
    : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  graphql_public: {
    Enums: {},
  },
  public: {
    Enums: {
      inspection_item_status: ["ok", "issue"],
      invoice_kind: ["work-order", "ticket-replenishment"],
      job_status: [
        "draft",
        "scheduled",
        "active",
        "completed",
        "delayed",
        "cancelled",
      ],
      movement_correlation: ["matches", "mismatch", "pending"],
      notification_type: ["job", "approval", "alert", "system"],
      purchase_request_status: ["pending", "approved", "rejected", "ordered"],
      qbo_sync_status: ["not-synced", "pending", "synced", "failed"],
      sms_delivery_status: ["queued", "sent", "delivered", "failed"],
      ticket_photo_status: ["awaiting-entry", "entered"],
      ticket_report_frequency: ["off", "daily", "weekly", "monthly"],
      ticket_txn_kind: ["debit", "credit", "adjustment"],
      token_scope: ["forms", "job", "shift", "tickets"],
      tool_condition: ["ok", "missing", "damaged"],
      urgency_level: ["low", "medium", "high"],
      user_role: ["admin", "driver", "mechanic"],
      user_status: ["active", "inactive", "suspended"],
      vehicle_status: ["operational", "maintenance", "out-of-service"],
      vehicle_type: ["truck", "trailer", "equipment"],
      work_order_status: ["pending", "approved", "rejected"],
    },
  },
} as const
